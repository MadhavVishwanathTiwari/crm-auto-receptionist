-- The assistant that answers when nobody else has.
--
-- A prospect replies. poll-replies writes a `replied` event, the sequence
-- halts, an alert fires and a phone buzzes -- and then nothing happens until a
-- human opens Gmail. Between two operators in IST and prospects in US business
-- hours that gap is routinely hours. This is the thing that closes it: five
-- minutes after a reply arrives, if nobody has answered, an assistant does.
--
-- Three properties are structural rather than careful:
--
--   1. It cannot answer a stranger. Its candidates are `replied` lead_events,
--      and poll-replies only writes one for mail matchLead() resolved to a lead
--      in this org. Mail from anyone else is counted `unmatched` and dropped
--      before it ever becomes an event. The route narrows further still: the
--      address that wrote has to be the lead's own, because matchLead() can
--      attribute a thread by its References chain to a message sent from any
--      address at all.
--
--   2. It ships switched off. `ai_reply_mode` is off | draft | send, default
--      off, the same shape as org_settings.dry_run. In `draft` it writes the
--      email it would have sent and sends nothing.
--
--   3. It cannot send twice. claim_ai_reply() inserts the row BEFORE Gmail is
--      called, under a per-mailbox advisory lock, and the unique index on
--      (org_id, inbound_message_id) is what arbitrates between two overlapping
--      ticks. This is the dispatcher's "mark sending before calling Gmail"
--      rule, for the same reason: a function killed mid-request has to leave a
--      visibly stuck row rather than a claimable one.
--
-- An AI reply is NOT a scheduled_sends row. step_number is constrained 1..4 and
-- a reply is not a step; claim_due_sends() refuses any send for a lead that
-- reached Gmail in the last 20 hours (0042) and a reply is usually hours after
-- the touch it answers; and the `replied` event has already halted that lead,
-- so the dispatcher's path would be fighting the halt its own trigger created.
--
-- It is still a real email out of a real Gmail account, though, and that part
-- is NOT exempt. 0041 exists because two emails left one account seconds apart.
-- A reply that ignored mailboxes.next_send_not_before would be that bug back.
-- A reply that did not count against daily_cap would silently over-send, which
-- CLAUDE.md is explicit is a reputation limit on the SENDING ACCOUNT and not an
-- outreach budget. So ai_replies carries cap_date exactly as scheduled_sends
-- does, claim_ai_reply() honours the gap and closes it behind itself, and
-- claim_due_sends() is restated below to count both pipelines.

-- ---------------------------------------------------------------------------
-- 1. The knobs
-- ---------------------------------------------------------------------------

create type ai_reply_mode as enum ('off', 'draft', 'send');

create type ai_reply_outcome as enum (
  -- Claimed, Gmail not yet called. The dispatcher's `sending`, and it means the
  -- same thing: nobody may claim this again, and only a person settles it.
  'sending',
  -- Considered and deliberately not answered. Carries the reason.
  'skipped',
  -- Written, not sent, because the org is in draft mode.
  'drafted',
  'sent',
  -- A 4xx from Gmail, a guard refusal, or a model answer we could not use.
  'failed',
  -- Gmail may or may not have taken it: a timeout, a 5xx, a 200 with no id.
  -- Never retried, because a wrong guess is a second email to a prospect.
  'stalled'
);

alter table org_settings
  add column ai_reply_mode ai_reply_mode not null default 'off',

  -- Measured from Gmail's internalDate -- when the mail ARRIVED -- never from
  -- lead_events.occurred_at, which is when poll-replies got round to writing
  -- the row. After a poller backlog those differ by hours, and gating on the
  -- wrong one makes a whole day's replies instantly eligible at once.
  add column ai_reply_delay_minutes smallint not null default 5,

  -- The cost fuse, per org per day. Separate from daily_cap, which is Gmail's
  -- limit on an account; this one is the bill.
  add column ai_reply_daily_cap smallint not null default 20,

  -- Set whenever ai_reply_mode leaves 'off'. Nothing older than this is ever a
  -- candidate, so switching the feature on does not answer a day of backlog in
  -- one tick.
  add column ai_reply_enabled_at timestamptz,

  -- The cal.com link. `send` mode does nothing without it: an interested reply
  -- with nowhere to book is the one outcome worse than no reply.
  add column booking_url text,

  -- Who we are, in the operator's own words. Freeform on purpose -- a schema
  -- for "what the business does" is a schema nobody fills in.
  add column business_context text not null default '',

  add constraint org_settings_ai_reply_delay
    check (ai_reply_delay_minutes between 1 and 1440),
  add constraint org_settings_ai_reply_daily_cap
    check (ai_reply_daily_cap between 0 and 200),
  add constraint org_settings_booking_url
    check (booking_url is null or booking_url ~ '^https://');

comment on column org_settings.ai_reply_mode is
  'off | draft | send. The kill switch, checked before any Gmail or model call.';
comment on column org_settings.ai_reply_enabled_at is
  'When the mode last left off. Replies older than this are never answered.';

-- ---------------------------------------------------------------------------
-- 2. What the assistant is allowed to know
-- ---------------------------------------------------------------------------
-- A table rather than a file in the repo, because "we changed the price" must
-- not be a deploy, and because either operator has to be able to fix a wrong
-- answer the moment they read one.

create table kb_entries (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,

  question   text not null,
  answer     text not null,

  -- Deactivating beats deleting: a wrong answer is worth keeping visible while
  -- somebody works out what the right one is.
  is_active  boolean not null default true,
  sort_order smallint not null default 0,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint kb_entries_question_not_blank check (btrim(question) <> ''),
  constraint kb_entries_answer_not_blank   check (btrim(answer) <> '')
);

create index kb_entries_active_idx on kb_entries (org_id, sort_order)
  where is_active;

create trigger kb_entries_set_updated_at before update on kb_entries
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. What it did, every time
-- ---------------------------------------------------------------------------
-- One row per inbound message considered, whatever the outcome. The skipped
-- ones are the majority and they are the point: without them the same event is
-- re-evaluated on every two-minute tick, which is a model call each time, and
-- there is no way to answer "why did it not reply to this one".

create table ai_replies (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  lead_id    uuid not null references leads(id) on delete cascade,
  mailbox_id uuid references mailboxes(id) on delete set null,

  -- The message being answered. Gmail's own ids, so a rerun, an overlapping
  -- poll page and a second tick all collide on the unique index below.
  inbound_message_id  text not null,
  inbound_thread_id   text not null,
  -- Gmail's internalDate. The clock the delay is measured against.
  inbound_received_at timestamptz not null,

  outcome     ai_reply_outcome not null,
  -- The model's own classification, null when we never reached the model.
  intent      text,
  -- Always present, including on a skip. This is the column an operator reads.
  reason      text not null,
  -- The model punted: it said a person would follow up.
  needs_human boolean not null default false,

  draft_subject text,
  draft_body    text,

  -- The mailbox's local date at claim, for the cap. Same semantics and the same
  -- name as scheduled_sends.cap_date, so every place that counts a mailbox's
  -- day counts this the same way.
  cap_date date,

  provider_message_id text,
  provider_thread_id  text,
  -- Gmail's Message-ID for what went out, read back after the send. Null means
  -- it could not be read, NEVER that nothing was sent.
  rfc822_message_id   text,
  sent_at             timestamptz,

  model         text,
  input_tokens  integer,
  output_tokens integer,
  error         text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ai_replies_reason_not_blank check (btrim(reason) <> ''),
  -- A sent row has to be able to prove it.
  constraint ai_replies_sent_has_provider check (
    outcome <> 'sent' or (provider_message_id is not null and sent_at is not null)
  ),
  -- One consideration per inbound message. This is the whole concurrency story.
  unique (org_id, inbound_message_id)
);

create index ai_replies_lead_idx on ai_replies (lead_id, created_at desc);
-- The once-per-thread rule: has the assistant already answered this lead.
create index ai_replies_answered_idx on ai_replies (org_id, lead_id)
  where outcome in ('sending', 'sent', 'stalled');
-- The daily cost fuse, and the /knowledge report.
create index ai_replies_recent_idx on ai_replies (org_id, created_at desc);
-- The mailbox cap, read the same way scheduled_sends' is.
create index ai_replies_cap_idx on ai_replies (mailbox_id, cap_date)
  where outcome in ('sending', 'sent', 'stalled');

create trigger ai_replies_set_updated_at before update on ai_replies
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. RLS and grants
-- ---------------------------------------------------------------------------
-- Since 0045 no default privilege hands anything to anyone, so both tables are
-- reachable by nobody until the grants below. anon is granted the same shape as
-- its neighbours in 0045 and denied every row by policy, which is what lets the
-- "anon reads nothing" tests prove RLS rather than a missing grant.
--
-- Every predicate wraps the helper in a scalar subquery, per 0030: those
-- helpers are security definer, Postgres never inlines one, and unwrapped it is
-- called once per row.

alter table kb_entries enable row level security;
alter table ai_replies enable row level security;

create policy kb_entries_select on kb_entries
  for select to authenticated
  using (org_id = (select app.current_org_id()));

-- Writing the knowledge base is writing what the assistant says in your name,
-- which is the same authority as flipping dry_run. Admin, like org_settings.
create policy kb_entries_insert on kb_entries
  for insert to authenticated
  with check (org_id = (select app.current_org_id()) and (select app.is_admin()));

create policy kb_entries_update on kb_entries
  for update to authenticated
  using (org_id = (select app.current_org_id()) and (select app.is_admin()))
  with check (org_id = (select app.current_org_id()) and (select app.is_admin()));

create policy kb_entries_delete on kb_entries
  for delete to authenticated
  using (org_id = (select app.current_org_id()) and (select app.is_admin()));

-- ai_replies is written by the cron and read by people. No insert or update
-- policy for `authenticated` at all: there is no approve-and-send button, and a
-- row an operator could edit is a row that stops being a record of what
-- happened.
create policy ai_replies_select on ai_replies
  for select to authenticated
  using (org_id = (select app.current_org_id()));

grant select, insert, update, delete on table public.kb_entries
  to anon, authenticated, service_role;
grant select on table public.ai_replies to anon, authenticated;
grant select, insert, update on table public.ai_replies to service_role;

-- ---------------------------------------------------------------------------
-- 5. Claiming a reply
-- ---------------------------------------------------------------------------
-- Everything that has to be true before Gmail is called, decided in one
-- transaction under one lock, and the row written before the call rather than
-- after it.
--
-- The advisory lock is TRANSACTION scoped, for the reason 0041 records: this is
-- reached over PostgREST, which runs each RPC in its own transaction on a
-- pooled connection it then hands to the next request. A session lock would
-- outlive the request and leak on any error path between lock and unlock.

create or replace function public.claim_ai_reply(
  p_org_id              uuid,
  p_lead_id             uuid,
  p_mailbox_id          uuid,
  p_inbound_message_id  text,
  p_inbound_thread_id   text,
  p_inbound_received_at timestamptz,
  -- draft mode claims a row too, so the same event is never drafted twice, but
  -- it does not touch the mailbox gate or the cap: nothing is being sent.
  p_will_send           boolean default true
) returns table (reply_id uuid, refused text)
language plpgsql security definer set search_path = '' as $$
declare
  v_settings public.org_settings;
  v_mailbox  record;
  v_today    date;
  v_used     int;
  v_id       uuid;
  v_previous text;
begin
  select * into v_settings from public.org_settings where org_id = p_org_id;
  if not found then
    return query select null::uuid, 'no_settings'::text;
    return;
  end if;

  if v_settings.ai_reply_mode = 'off' then
    return query select null::uuid, 'mode_off'::text;
    return;
  end if;

  -- Cheap and lock-free: a rerun over a message already considered is the
  -- common case, and it must not queue behind another mailbox's claim.
  if exists (
    select 1 from public.ai_replies a
     where a.org_id = p_org_id
       and a.inbound_message_id = p_inbound_message_id
  ) then
    return query select null::uuid, 'already_considered'::text;
    return;
  end if;

  -- The once-per-thread rule. A prospect who writes twice is a conversation,
  -- and that is a person's job.
  if exists (
    select 1 from public.ai_replies a
     where a.org_id = p_org_id
       and a.lead_id = p_lead_id
       and a.outcome in ('sending', 'sent', 'stalled')
  ) then
    return query select null::uuid, 'already_answered'::text;
    return;
  end if;

  if p_will_send then
    perform pg_advisory_xact_lock(hashtextextended(p_mailbox_id::text, 0));

    -- Read under the lock, not before it.
    select m.id, m.timezone, m.daily_cap, m.is_sendable, m.next_send_not_before,
           m.display_name
      into v_mailbox
      from public.mailboxes m
     where m.id = p_mailbox_id and m.org_id = p_org_id;

    if not found then
      return query select null::uuid, 'no_mailbox'::text;
      return;
    end if;

    -- Pausing a mailbox is an operator saying "stop sending from this account".
    -- An assistant that sent anyway would be the most surprising thing this
    -- feature could do. dispatch-sends refuses a paused mailbox the same way.
    if not v_mailbox.is_sendable then
      return query select null::uuid, 'mailbox_paused'::text;
      return;
    end if;

    -- The From header, and the name the assistant signs off as.
    if v_mailbox.display_name is null or btrim(v_mailbox.display_name) = '' then
      return query select null::uuid, 'no_display_name'::text;
      return;
    end if;

    -- 0041's gap. A reply waiting up to send_gap_max_minutes is fine; two
    -- emails leaving one account in the same second is not.
    if v_mailbox.next_send_not_before is not null
       and v_mailbox.next_send_not_before > now() then
      return query select null::uuid, 'gap_not_elapsed'::text;
      return;
    end if;

    v_today := (timezone(v_mailbox.timezone, now()))::date;

    -- Both pipelines. A reply is a real send out of this account and counts.
    select (
      select count(*) from public.scheduled_sends s
       where s.mailbox_id = p_mailbox_id
         and s.cap_date = v_today
         and s.status in ('claimed', 'sending', 'sent')
    ) + (
      select count(*) from public.ai_replies a
       where a.mailbox_id = p_mailbox_id
         and a.cap_date = v_today
         and a.outcome in ('sending', 'sent', 'stalled')
    ) into v_used;

    if v_used >= v_mailbox.daily_cap then
      return query select null::uuid, 'mailbox_at_cap'::text;
      return;
    end if;
  else
    v_today := null;
  end if;

  insert into public.ai_replies (
    org_id, lead_id, mailbox_id,
    inbound_message_id, inbound_thread_id, inbound_received_at,
    outcome, reason, cap_date
  ) values (
    p_org_id, p_lead_id, p_mailbox_id,
    p_inbound_message_id, p_inbound_thread_id, p_inbound_received_at,
    (case when p_will_send then 'sending' else 'skipped' end)::public.ai_reply_outcome,
    case when p_will_send then 'claimed, not yet sent'
         else 'claimed for a draft' end,
    v_today
  )
  on conflict (org_id, inbound_message_id) do nothing
  returning id into v_id;

  if v_id is null then
    -- Another tick won the race between the check above and here. That is the
    -- unique index doing its job, not an error.
    return query select null::uuid, 'already_considered'::text;
    return;
  end if;

  -- Close the gate behind the claim, not after Gmail answers: the next tick can
  -- start before this one reaches the Gmail call. Same reasoning as 0041.
  if p_will_send then
    v_previous := coalesce(current_setting('app.bypass_mailbox_guard', true), 'off');
    perform set_config('app.bypass_mailbox_guard', 'on', true);

    update public.mailboxes m
       set next_send_not_before = now() + make_interval(secs =>
             (v_settings.send_gap_min_minutes
              + random() * (v_settings.send_gap_max_minutes
                            - v_settings.send_gap_min_minutes)) * 60)
     where m.id = p_mailbox_id;

    perform set_config('app.bypass_mailbox_guard', v_previous, true);
  end if;

  return query select v_id, null::text;
end;
$$;

comment on function public.claim_ai_reply(uuid, uuid, uuid, text, text, timestamptz, boolean) is
  'Everything that must hold before an AI reply reaches Gmail, in one transaction under a per-mailbox advisory lock. Writes the row BEFORE the send, so two overlapping runs cannot both send.';

revoke all on function public.claim_ai_reply(uuid, uuid, uuid, text, text, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_ai_reply(uuid, uuid, uuid, text, text, timestamptz, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- 6. Settling one
-- ---------------------------------------------------------------------------
-- The row, the lead_event and the mailbox stamp in one transaction, the same
-- shape as mark_send_sent(). mailboxes.last_send_at is guarded, so this sets
-- the bypass -- the 0013 lesson: inside a SECURITY DEFINER, current_user is the
-- function's owner and not the caller, so a guard that trusts 'service_role'
-- does not trust this.

create or replace function public.finish_ai_reply(
  p_reply_id            uuid,
  p_outcome             ai_reply_outcome,
  p_reason              text,
  p_intent              text default null,
  p_needs_human         boolean default false,
  p_subject             text default null,
  p_body                text default null,
  p_provider_message_id text default null,
  p_provider_thread_id  text default null,
  p_rfc822_message_id   text default null,
  p_model               text default null,
  p_input_tokens        int default null,
  p_output_tokens       int default null,
  p_error               text default null
) returns public.ai_replies
language plpgsql security definer set search_path = '' as $$
declare
  v_row      public.ai_replies;
  v_previous text;
begin
  update public.ai_replies a
     set outcome             = p_outcome,
         reason              = coalesce(nullif(btrim(p_reason), ''), a.reason),
         intent              = coalesce(p_intent, a.intent),
         needs_human         = p_needs_human,
         draft_subject       = coalesce(p_subject, a.draft_subject),
         draft_body          = coalesce(p_body, a.draft_body),
         provider_message_id = coalesce(p_provider_message_id, a.provider_message_id),
         provider_thread_id  = coalesce(p_provider_thread_id, a.provider_thread_id),
         rfc822_message_id   = coalesce(p_rfc822_message_id, a.rfc822_message_id),
         sent_at             = case when p_outcome = 'sent' then coalesce(a.sent_at, now())
                                    else a.sent_at end,
         model               = coalesce(p_model, a.model),
         input_tokens        = coalesce(p_input_tokens, a.input_tokens),
         output_tokens       = coalesce(p_output_tokens, a.output_tokens),
         error               = p_error
   where a.id = p_reply_id
  returning a.* into v_row;

  if v_row.id is null then
    raise exception 'no such AI reply' using errcode = '22023';
  end if;

  if p_outcome = 'sent' then
    -- The timeline entry. Its own event type rather than `note`, so a person
    -- reading the drawer can tell who wrote it. Keyed on Gmail's message id, so
    -- a retry of this call writes no second one -- the unique index treats
    -- NULL dedupe_tokens as distinct, which is why it must never be null here.
    insert into public.lead_events (org_id, lead_id, type, actor_id, payload, dedupe_token)
    values (
      v_row.org_id, v_row.lead_id, 'ai_replied', null,
      jsonb_build_object(
        -- LeadDrawer renders a timeline body from payload->>'body'.
        'body', coalesce(v_row.draft_body, ''),
        'subject', v_row.draft_subject,
        'mailbox_id', v_row.mailbox_id,
        'gmail_message_id', v_row.provider_message_id,
        'gmail_thread_id', v_row.provider_thread_id,
        'in_reply_to', v_row.inbound_message_id,
        'intent', v_row.intent,
        'needs_human', v_row.needs_human
      ),
      v_row.provider_message_id
    )
    on conflict (lead_id, type, dedupe_token) do nothing;

    v_previous := coalesce(current_setting('app.bypass_mailbox_guard', true), 'off');
    perform set_config('app.bypass_mailbox_guard', 'on', true);

    update public.mailboxes m
       set last_send_at = greatest(coalesce(m.last_send_at, v_row.sent_at), v_row.sent_at)
     where m.id = v_row.mailbox_id;

    perform set_config('app.bypass_mailbox_guard', v_previous, true);
  end if;

  return v_row;
end;
$$;

comment on function public.finish_ai_reply is
  'Settles a claimed AI reply: the row, the ai_replied timeline event and the mailbox stamp, in one transaction.';

revoke all on function public.finish_ai_reply(
  uuid, ai_reply_outcome, text, text, boolean, text, text, text, text, text, text, int, int, text
) from public, anon, authenticated;
grant execute on function public.finish_ai_reply(
  uuid, ai_reply_outcome, text, text, boolean, text, text, text, text, text, text, int, int, text
) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Teaching the dispatcher that a reply was also an email
-- ---------------------------------------------------------------------------
-- Restated IN FULL from 0042, its latest version, with one change: v_used counts
-- ai_replies as well as scheduled_sends. Restated rather than patched for the
-- reason 0038 and 0044 both give, and from 0042 rather than 0041 because a copy
-- taken from the wrong version silently drops whatever the versions in between
-- added -- here 0042's "nothing reached Gmail for this lead in the last 20
-- hours", which is the ceiling on the next repeat bug.
--
-- That 20-hour clause deliberately still reads scheduled_sends only. A lead the
-- assistant answered has a `replied` event, so it is halted, so it has no
-- planned row for the clause to protect; widening it would be a rule with
-- nothing behind it.
--
-- Without this the claimer believes a mailbox has headroom it does not have. At
-- a 20/day cap and a handful of replies that is a couple of emails over, every
-- day, on the account whose reputation the cap exists to protect.

create or replace function public.claim_due_sends(
  p_org_id uuid,
  p_limit  int default 25
) returns setof public.scheduled_sends
language plpgsql security definer set search_path = '' as $$
declare
  v_settings  public.org_settings;
  v_mailbox   record;
  v_remaining int := p_limit;
  v_claimed   int;
  v_used      int;
  v_allowed   int;
  v_today     date;
  v_token     uuid := gen_random_uuid();
  v_previous  text;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'p_limit must be between 1 and 500' using errcode = '22023';
  end if;

  select * into v_settings from public.org_settings where org_id = p_org_id;
  if not found then
    return;
  end if;

  -- The kill switch.
  if v_settings.dry_run then
    return;
  end if;

  for v_mailbox in
    select m.id, m.timezone, m.daily_cap
      from public.mailboxes m
     where m.org_id = p_org_id
       and m.is_sendable
     order by m.id
  loop
    exit when v_remaining <= 0;

    perform pg_advisory_xact_lock(hashtextextended(v_mailbox.id::text, 0));

    -- 0041: still inside its gap. Read under the lock, not from the loop's
    -- row, which was read before the lock was taken.
    if exists (
      select 1 from public.mailboxes m
       where m.id = v_mailbox.id
         and m.next_send_not_before > now()
    ) then
      continue;
    end if;

    v_today := (timezone(v_mailbox.timezone, now()))::date;

    -- 0053: both pipelines. An AI reply left this same Gmail account today.
    select (
      select count(*)
        from public.scheduled_sends s
       where s.mailbox_id = v_mailbox.id
         and s.cap_date = v_today
         and s.status in ('claimed', 'sending', 'sent')
    ) + (
      select count(*)
        from public.ai_replies a
       where a.mailbox_id = v_mailbox.id
         and a.cap_date = v_today
         and a.outcome in ('sending', 'sent', 'stalled')
    ) into v_used;

    -- 0041: one per mailbox per run, however many are due.
    v_allowed := least(v_remaining, v_mailbox.daily_cap - v_used, 1);
    if v_allowed <= 0 then
      continue;
    end if;

    return query
    with due as (
      select s.id
        from public.scheduled_sends s
        join public.leads l on l.id = s.lead_id
       where s.org_id = p_org_id
         and s.mailbox_id = v_mailbox.id
         and s.status = 'planned'
         and s.scheduled_at <= now()
         and s.scheduled_at > now() - make_interval(mins => v_settings.slot_grace_minutes)
         and l.halted_at is null
         and l.terminal_outcome is null
         and l.archived_at is null
         -- 0040: an earlier send to this lead may have gone out unrecorded.
         and not exists (
           select 1 from public.scheduled_sends x
            where x.lead_id = s.lead_id
              and x.status = 'failed'
              and x.error_code = 'stalled'
         )
         -- 0042: nothing reached Gmail for this lead in the last 20 hours.
         and not exists (
           select 1 from public.scheduled_sends y
            where y.lead_id = s.lead_id
              and y.id <> s.id
              and greatest(y.sending_at, y.sent_at) > now() - interval '20 hours'
         )
       order by s.scheduled_at
       limit v_allowed
       for update of s skip locked
    )
    update public.scheduled_sends s
       set status      = 'claimed',
           claimed_at  = now(),
           claim_token = v_token,
           cap_date    = v_today,
           attempts    = s.attempts + 1
     where s.id in (select id from due)
    returning s.*;

    get diagnostics v_claimed = row_count;
    v_remaining := v_remaining - v_claimed;

    -- 0041: close the gate behind it, for a random gap between min and max.
    if v_claimed > 0 then
      v_previous := coalesce(current_setting('app.bypass_mailbox_guard', true), 'off');
      perform set_config('app.bypass_mailbox_guard', 'on', true);

      update public.mailboxes m
         set next_send_not_before = now() + make_interval(secs =>
               (v_settings.send_gap_min_minutes
                + random() * (v_settings.send_gap_max_minutes
                              - v_settings.send_gap_min_minutes)) * 60)
       where m.id = v_mailbox.id;

      perform set_config('app.bypass_mailbox_guard', v_previous, true);
    end if;
  end loop;
end;
$$;

revoke all on function public.claim_due_sends(uuid, int) from public, anon, authenticated;
grant execute on function public.claim_due_sends(uuid, int) to service_role;
