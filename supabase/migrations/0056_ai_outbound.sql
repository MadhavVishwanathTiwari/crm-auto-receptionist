-- The assistant writes first emails.
--
-- Phase 1 (0052-0054) answers replies nobody got to. This is the other end of
-- the thread: a few times a day it takes an unclaimed lead, reads the
-- business's own website, and writes the T1 an operator would have written.
--
-- The architectural claim from the phase 1 plan holds: the assistant is just
-- another writer. Its email becomes a `scheduled_sends` row with
-- `composed_body`, exactly what /write produces, so suppression, caps,
-- threading, stall reaping, the reply halt and dry_run all apply to it
-- unchanged, and T2 and T3 follow from the template sequence like any other
-- lead's. No new send machinery exists.
--
-- Off, draft, send, on `org_settings.ai_outbound_mode`, the same enum and the
-- same shape as `ai_reply_mode`:
--
--   draft  the lead is claimed for the owner of `ai_outbound_mailbox_id` and
--          the email waits on that operator's /write, pre-filled. Nothing is
--          booked until a person presses Ctrl+Enter, and that send goes
--          through queue_composed_send() as theirs, because by then it is:
--          they read it and chose to send it. attach_ai_draft() records that
--          it started as the assistant's, and whether they changed it.
--   send   the same claim, plus a `blocked` step-1 row carrying the words. The
--          planner already rolls a blocked written row forward into a real
--          slot, keeping its words (plan-sends, `written`), so it books this
--          one within fifteen minutes using the one copy of the capacity
--          arithmetic there is. Writing a second slot picker here is the
--          mistake book.ts exists to prevent.
--
-- Why it claims an UNCLAIMED lead rather than writing to an operator's own:
-- the leads somebody claimed are the ones they meant to write themselves.
-- The pool nobody has picked up is where the assistant adds sends rather than
-- replacing a person's. Claiming is also what makes every existing rule hold:
-- 0032 routing sends from the owner's mailbox, /write shows the owner the
-- lead, and queue_composed_send() accepts the owner's Ctrl+Enter.
--
-- Authorship (the open question from the plan): `composed_by` is a FK to a
-- human, and the assistant is not one. A send-mode row therefore carries
-- `composed_by` null and `ai_outbound_id` set; a draft an operator sent
-- carries their id in `composed_by` AND the `ai_outbound_id`. The timeline
-- never credits a person with words they did not write, and never hides that
-- they approved them.

-- ---------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------

create type ai_outbound_outcome as enum (
  -- It looked and decided not to write: not a fit, nothing to say, a site it
  -- could not read. The lead stays in the pool for a person.
  'skipped',
  -- Written and waiting on an operator's /write.
  'drafted',
  -- Written and handed to the planner (send mode).
  'queued',
  -- It tried to write and what came back would not pass the guard.
  'failed'
);

alter table org_settings
  add column ai_outbound_mode ai_reply_mode not null default 'off',
  -- Drafts plus queued sends a day, in operator_timezone. Skips do not count:
  -- a lead it passed on cost one model call and no mailbox.
  add column ai_outbound_daily smallint not null default 5,
  -- The account it writes as. Its owner is who the lead is claimed for, and
  -- its display name is the sign-off.
  add column ai_outbound_mailbox_id uuid references mailboxes(id) on delete set null,
  add constraint org_settings_ai_outbound_daily check (ai_outbound_daily between 0 and 50);

-- ---------------------------------------------------------------------------
-- 2. What it did
-- ---------------------------------------------------------------------------

create table ai_outbound (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete cascade,
  lead_id           uuid not null references leads(id) on delete cascade,
  mailbox_id        uuid references mailboxes(id) on delete set null,
  -- Who the lead was claimed for. Null on a skip, which claims nothing.
  owner_id          uuid references auth.users(id) on delete set null,
  outcome           ai_outbound_outcome not null,
  -- Always says why, including when it wrote nothing. A skip with no reason
  -- is a row nobody can learn from.
  reason            text not null check (btrim(reason) <> ''),
  subject           text,
  body              text,
  -- How much of the website it actually read. 0 means it wrote blind.
  website_chars     int,
  -- Set when the email exists as a send: at once in send mode, on Ctrl+Enter
  -- in draft mode.
  scheduled_send_id uuid references scheduled_sends(id) on delete set null,
  used_at           timestamptz,
  -- Whether the operator changed the words before sending. Null until used.
  edited            boolean,
  model             text,
  input_tokens      int,
  output_tokens     int,
  created_at        timestamptz not null default now(),
  -- A lead is considered once. A skip is a decision, and re-deciding it every
  -- run is how a fuse of five a day becomes a bill.
  constraint ai_outbound_one_per_lead unique (org_id, lead_id),
  constraint ai_outbound_written_has_words check (
    outcome not in ('drafted', 'queued')
    or (subject is not null and body is not null)
  )
);

create index ai_outbound_day_idx on ai_outbound (org_id, created_at desc);
create index ai_outbound_unused_idx on ai_outbound (owner_id)
  where outcome = 'drafted' and scheduled_send_id is null;

alter table scheduled_sends
  add column ai_outbound_id uuid references ai_outbound(id) on delete set null;

comment on column scheduled_sends.ai_outbound_id is
  'The assistant wrote these words (0056). composed_by is null when it also sent them, and the operator when they approved a draft.';

alter table ai_outbound enable row level security;

-- Read by the org; written only by the cron and the two functions below. Same
-- reasoning as ai_replies: a row an operator could edit stops being a record
-- of what the assistant did.
create policy ai_outbound_select on ai_outbound
  for select to authenticated
  using (org_id = (select app.current_org_id()));

grant select on table public.ai_outbound to anon, authenticated;
grant select, insert, update on table public.ai_outbound to service_role;

-- ---------------------------------------------------------------------------
-- 3. record_ai_outbound(): claim, record, and in send mode queue
-- ---------------------------------------------------------------------------
--
-- One transaction, because each half without the other is a bug: a claimed
-- lead with no draft sits on somebody's /write with an empty composer, and a
-- draft for a lead somebody else claimed in the meantime is an email to a lead
-- that is not ours to write to.
--
-- The model call happens before this, in TypeScript, so every check that can
-- have changed while it ran is made again here under a row lock.

create or replace function public.record_ai_outbound(
  p_org           uuid,
  p_lead_id       uuid,
  p_mailbox_id    uuid,
  p_send          boolean,
  p_subject       text,
  p_body          text,
  p_reason        text,
  p_model         text,
  p_input_tokens  int,
  p_output_tokens int,
  p_website_chars int
) returns public.ai_outbound
language plpgsql security definer set search_path = '' as $$
declare
  v_settings public.org_settings;
  v_lead     public.leads;
  v_mailbox  public.mailboxes;
  v_today    int;
  v_row      public.ai_outbound;
  v_send     public.scheduled_sends;
  v_local    timestamp;
begin
  if p_subject is null or btrim(p_subject) = ''
     or p_body is null or btrim(p_body) = '' then
    raise exception 'a written email needs a subject and a body' using errcode = '22023';
  end if;

  -- Serializes the daily count against a second run. Transaction-scoped for
  -- the reason claim_due_sends() is: this is reached over PostgREST.
  perform pg_advisory_xact_lock(hashtext('ai_outbound:' || p_org::text));

  select * into v_settings from public.org_settings s where s.org_id = p_org;
  if not found then
    raise exception 'no settings for org %', p_org using errcode = '22023';
  end if;

  select count(*) into v_today
    from public.ai_outbound a
   where a.org_id = p_org
     and a.outcome in ('drafted', 'queued')
     and a.created_at >= (date_trunc('day', now() at time zone v_settings.operator_timezone)
                          at time zone v_settings.operator_timezone);

  if v_today >= v_settings.ai_outbound_daily then
    raise exception 'the assistant has written its % for today', v_settings.ai_outbound_daily
      using errcode = '55006';
  end if;

  select * into v_lead
    from public.leads l
   where l.id = p_lead_id and l.org_id = p_org
   for update;

  if not found then
    raise exception 'that lead is not in this org' using errcode = '42501';
  end if;

  -- Somebody claimed it while the model was writing. Theirs now.
  if v_lead.claimed_by is not null then
    raise exception 'that lead was claimed while the assistant was writing'
      using errcode = '55006';
  end if;

  if v_lead.archived_at is not null or v_lead.halted_at is not null
     or v_lead.terminal_outcome is not null or not v_lead.is_qualified then
    raise exception 'that lead is closed, halted or not qualified' using errcode = '55006';
  end if;

  if v_lead.work_email is null or btrim(v_lead.work_email) = '' then
    raise exception 'that lead has no work email' using errcode = '22023';
  end if;

  if v_lead.timezone is null then
    raise exception 'that lead has no timezone, so it is never scheduled' using errcode = '22023';
  end if;

  -- Never a lead with any history: a first touch is the only thing this writes.
  if exists (select 1 from public.scheduled_sends s where s.lead_id = p_lead_id) then
    raise exception 'that lead already has an email booked or sent' using errcode = '55006';
  end if;

  if exists (
    select 1 from public.suppressions s
     where s.org_id = p_org
       and (s.email_norm = v_lead.work_email_norm
            or (s.domain is not null and s.domain = v_lead.website_domain))
  ) then
    raise exception 'that address is on the do-not-contact list' using errcode = '55006';
  end if;

  select * into v_mailbox
    from public.mailboxes m
   where m.id = p_mailbox_id and m.org_id = p_org and m.is_sendable;

  if not found then
    raise exception 'the assistant''s mailbox is not connected or not sendable'
      using errcode = '22023';
  end if;

  if v_mailbox.user_id is null then
    raise exception 'the assistant''s mailbox has no owner to claim the lead for'
      using errcode = '22023';
  end if;

  if v_mailbox.display_name is null or btrim(v_mailbox.display_name) = '' then
    raise exception 'the assistant''s mailbox has no display name, which is its sign-off'
      using errcode = '22023';
  end if;

  -- The claim, under the same bypass and with the same re-check claim_lead()
  -- and assign_lead_owner_one() use.
  perform set_config('app.bypass_lead_guard', 'on', true);

  update public.leads l
     set claimed_by  = v_mailbox.user_id,
         claimed_at  = now(),
         released_at = null,
         claim_count = l.claim_count + 1
   where l.id = p_lead_id
     and l.claimed_by is null;

  if not found then
    raise exception 'that lead was claimed while the assistant was writing'
      using errcode = '55006';
  end if;

  -- The owner as actor, as 0025 does: they own it now. The payload says how.
  insert into public.lead_events (org_id, lead_id, type, actor_id, payload)
  values (p_org, p_lead_id, 'claimed', v_mailbox.user_id,
          jsonb_build_object('source', 'ai_outbound', 'send', p_send));

  insert into public.ai_outbound (
    org_id, lead_id, mailbox_id, owner_id, outcome, reason,
    subject, body, website_chars, model, input_tokens, output_tokens
  ) values (
    p_org, p_lead_id, p_mailbox_id, v_mailbox.user_id,
    (case when p_send then 'queued' else 'drafted' end)::public.ai_outbound_outcome,
    p_reason, btrim(p_subject), btrim(p_body), p_website_chars,
    p_model, p_input_tokens, p_output_tokens
  )
  returning * into v_row;

  if not p_send then
    return v_row;
  end if;

  -- Blocked, not planned: the planner chooses the slot (see the header). A
  -- blocked row still carries one, because the column is NOT NULL, and the
  -- honest value is "now", the same one the planner writes on its own blocks.
  v_local := (now() at time zone v_lead.timezone);

  insert into public.scheduled_sends (
    org_id, lead_id, mailbox_id, template_id,
    step_number, touch_kind, status, outcome_reason,
    scheduled_at, scheduled_local, prospect_timezone,
    composed_subject, composed_body, composed_by, composed_at, ai_outbound_id
  ) values (
    p_org, p_lead_id, p_mailbox_id, null,
    1, 'first', 'blocked', 'written by the assistant; the planner picks its slot',
    now(), v_local, v_lead.timezone,
    btrim(p_subject), btrim(p_body), null, now(), v_row.id
  )
  returning * into v_send;

  -- `queued` is what makes the lead sendable to the planner, exactly as
  -- queue_composed_send() writes it. No actor: no person queued it.
  insert into public.lead_events (
    org_id, lead_id, type, actor_id, payload, scheduled_send_id, dedupe_token
  ) values (
    p_org, p_lead_id, 'queued', null,
    jsonb_build_object(
      'step_number', 1,
      'composed', true,
      'ai_outbound', true,
      'subject', btrim(p_subject)
    ),
    v_send.id, 'composed:' || v_send.id::text
  )
  on conflict (lead_id, type, dedupe_token) do nothing;

  update public.ai_outbound a
     set scheduled_send_id = v_send.id, used_at = now()
   where a.id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.record_ai_outbound(uuid, uuid, uuid, boolean, text, text, text, text, int, int, int)
  from public, anon, authenticated;
grant execute on function public.record_ai_outbound(uuid, uuid, uuid, boolean, text, text, text, text, int, int, int)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. attach_ai_draft(): an operator sent a draft
-- ---------------------------------------------------------------------------
--
-- Called by queueWrittenEmail() right after queue_composed_send() returns, so
-- the row says the words started as the assistant's and whether they changed.
-- Provenance only: the email is already booked either way, and a failure here
-- is reported rather than unbooking anything.

create or replace function public.attach_ai_draft(p_draft_id uuid, p_send_id uuid)
returns public.ai_outbound
language plpgsql security definer set search_path = '' as $$
declare
  v_org   uuid := app.current_org_id();
  v_user  uuid := auth.uid();
  v_draft public.ai_outbound;
  v_send  public.scheduled_sends;
begin
  if v_org is null then
    raise exception 'not a member of any org' using errcode = '42501';
  end if;

  select * into v_draft
    from public.ai_outbound a
   where a.id = p_draft_id and a.org_id = v_org
   for update;

  if not found then
    raise exception 'that draft is not available' using errcode = '42501';
  end if;

  if not app.same_operator(v_draft.owner_id, v_user) then
    raise exception 'that draft was written for somebody else' using errcode = '42501';
  end if;

  select * into v_send
    from public.scheduled_sends s
   where s.id = p_send_id and s.org_id = v_org and s.lead_id = v_draft.lead_id;

  if not found then
    raise exception 'that send is not for this draft''s lead' using errcode = '22023';
  end if;

  if v_draft.scheduled_send_id is not null and v_draft.scheduled_send_id <> p_send_id then
    raise exception 'that draft was already sent' using errcode = '55006';
  end if;

  update public.scheduled_sends s
     set ai_outbound_id = v_draft.id
   where s.id = p_send_id;

  update public.ai_outbound a
     set scheduled_send_id = p_send_id,
         used_at = coalesce(a.used_at, now()),
         edited  = (btrim(coalesce(v_send.composed_subject, '')) <> btrim(coalesce(a.subject, ''))
                    or btrim(coalesce(v_send.composed_body, '')) <> btrim(coalesce(a.body, '')))
   where a.id = v_draft.id
  returning * into v_draft;

  return v_draft;
end;
$$;

revoke all on function public.attach_ai_draft(uuid, uuid) from public, anon, authenticated;
grant execute on function public.attach_ai_draft(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Scheduling
-- ---------------------------------------------------------------------------
--
-- ai-outbound, every 30 minutes. Five a day does not need a faster tick, and
-- a run (a website fetch and a model call per lead) stays well inside it, so
-- two runs never overlap. With the mode off it returns before any fetch.
--
-- The three functions NAME the jobs, so they are restated in full from 0054
-- with the new one added, for the reason 0054 gives.

create or replace function app.enable_background_jobs() returns text
language plpgsql security definer set search_path = '' as $$
declare
  missing text[] := '{}';
begin
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Supabase Vault is not enabled on this project';
  end if;

  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'app_base_url' and btrim(decrypted_secret) <> ''
  ) then
    missing := missing || 'app_base_url'::text;
  end if;

  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'cron_secret' and btrim(decrypted_secret) <> ''
  ) then
    missing := missing || 'cron_secret'::text;
  end if;

  if array_length(missing, 1) > 0 then
    return 'not scheduled, missing vault secret(s): ' || array_to_string(missing, ', ');
  end if;

  perform cron.schedule('resolve-timezones', '7 * * * *',
    $job$select app.call_job('resolve-timezones')$job$);
  perform cron.schedule('plan-sends', '*/15 * * * *',
    $job$select app.call_job('plan-sends')$job$);
  perform cron.schedule('dispatch-sends', '* * * * *',
    $job$select app.call_job('dispatch-sends')$job$);
  perform cron.schedule('poll-replies', '*/5 * * * *',
    $job$select app.call_job('poll-replies')$job$);
  perform cron.schedule('ai-replies', '*/2 * * * *',
    $job$select app.call_job('ai-replies')$job$);
  perform cron.schedule('ai-outbound', '*/30 * * * *',
    $job$select app.call_job('ai-outbound')$job$);
  perform cron.schedule('reconcile-mailboxes', '30 23 * * *',
    $job$select app.call_job('reconcile-mailboxes')$job$);

  return 'scheduled: resolve-timezones, plan-sends, dispatch-sends, poll-replies, ai-replies, ai-outbound, reconcile-mailboxes';
end;
$$;

comment on function app.enable_background_jobs() is
  'Schedules the seven jobs, once vault holds app_base_url and cron_secret. Idempotent.';

create or replace function app.disable_background_jobs() returns text
language plpgsql security definer set search_path = '' as $$
declare
  job text;
begin
  foreach job in array array[
    'resolve-timezones', 'plan-sends', 'dispatch-sends', 'poll-replies',
    'ai-replies', 'ai-outbound', 'reconcile-mailboxes'
  ]
  loop
    if exists (select 1 from cron.job j where j.jobname = job) then
      perform cron.unschedule(job);
    end if;
  end loop;

  return 'unscheduled. Nothing runs by itself now.';
end;
$$;

create or replace function public.background_jobs_status()
returns table (
  job          text,
  schedule     text,
  active       boolean,
  last_run_at  timestamptz,
  last_status  text
)
language sql stable security definer set search_path = '' as $$
  select
    j.jobname::text,
    j.schedule::text,
    j.active,
    d.start_time,
    d.status::text
  from cron.job j
  left join lateral (
    select r.start_time, r.status
    from cron.job_run_details r
    where r.jobid = j.jobid
    order by r.start_time desc
    limit 1
  ) d on true
  where j.jobname in (
    'resolve-timezones', 'plan-sends', 'dispatch-sends', 'poll-replies',
    'ai-replies', 'ai-outbound', 'reconcile-mailboxes'
  );
$$;

revoke all on function public.background_jobs_status() from public, anon;
grant execute on function public.background_jobs_status() to authenticated;

-- Only if the others are already running; same rule as 0054.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'dispatch-sends') then
    perform cron.schedule('ai-outbound', '*/30 * * * *',
      $job$select app.call_job('ai-outbound')$job$);
    raise notice 'ai-outbound scheduled every 30 minutes';
  else
    raise notice 'background jobs are off; ai-outbound left unscheduled';
  end if;
end;
$$;
