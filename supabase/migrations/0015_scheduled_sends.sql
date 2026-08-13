-- The send queue itself: one row per intended touch, from the moment the
-- planner decides it should happen to the moment Gmail confirms it did.
--
-- The status enum has existed since 0001 with no table under it. This is that
-- table.

-- ---------------------------------------------------------------------------
-- Scheduling knobs the planner reads
-- ---------------------------------------------------------------------------
-- touch_kind has been in the vocabulary since 0001 with a comment saying first
-- touches prefer Tue/Wed/Thu and follow-ups carry Mon/Fri, "expressed as
-- per-weekday weights in config, never as hardcoded logic". These are that
-- config. ISO weekdays, 1 = Monday.
--
-- A first touch landing on a Monday competes with the weekend backlog and one
-- landing on a Friday gets read on Monday, by which time it is old. A follow-up
-- has already earned its place in the thread and does not pay that cost.

alter table org_settings
  add column first_touch_weekdays smallint[] not null default '{2,3,4}',
  add column followup_weekdays    smallint[] not null default '{1,2,3,4,5}',

  -- A send left in `sending` for longer than this had its dispatcher die
  -- mid-flight. It is failed rather than retried, because we cannot know
  -- whether Gmail accepted it and a retry would be a second email.
  add column stall_minutes smallint not null default 15,

  add constraint org_settings_first_touch_weekdays
    check (first_touch_weekdays <@ array[1,2,3,4,5]::smallint[]
           and array_length(first_touch_weekdays, 1) >= 1),
  add constraint org_settings_followup_weekdays
    check (followup_weekdays <@ array[1,2,3,4,5]::smallint[]
           and array_length(followup_weekdays, 1) >= 1),
  add constraint org_settings_stall_minutes check (stall_minutes between 1 and 240);

-- ---------------------------------------------------------------------------
-- scheduled_sends
-- ---------------------------------------------------------------------------

create table scheduled_sends (
  id      uuid primary key default gen_random_uuid(),
  org_id  uuid not null references orgs(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,

  -- Assigned at plan time, because the cap this send will be counted against
  -- resets in THIS mailbox's timezone and the planner has to know which day it
  -- is aiming at. ON DELETE SET NULL so removing a mailbox does not delete the
  -- history of what it sent.
  mailbox_id  uuid references mailboxes(id) on delete set null,
  template_id uuid references templates(id) on delete set null,

  step_number smallint not null,
  touch_kind  touch_kind not null,

  status scheduled_send_status not null default 'planned',

  -- The instant, and the prospect-local wall clock it was chosen to be. Both
  -- are stored: the instant is what the claimer compares against, and the local
  -- reading is what the queue screen shows an operator so nobody has to do
  -- timezone arithmetic in their head to sanity-check a slot.
  scheduled_at    timestamptz not null,
  scheduled_local timestamp   not null,
  prospect_timezone text not null,

  -- Bumped every time a missed slot is rolled forward. Feeds the planner's
  -- jitter seed, so a re-planned send lands on a different minute rather than
  -- deterministically colliding with the same busy slot again.
  plan_attempt smallint not null default 0,

  claimed_at    timestamptz,
  claim_token   uuid,
  sending_at    timestamptz,
  sent_at       timestamptz,

  -- The MAILBOX-local date this send is counted against, stamped at claim.
  -- Never the prospect's date: a 20/day cap is a Gmail reputation limit on the
  -- sending account and resets in the operator's day.
  cap_date date,

  -- What actually went out, frozen. The template may be edited afterwards, and
  -- "what did we say to this person" must not change when it is.
  rendered_subject text,
  rendered_body    text,

  provider_message_id text,
  provider_thread_id  text,
  -- Our own RFC 5322 Message-ID, kept so a follow-up can thread onto it and so
  -- an inbound reply can be matched back by References.
  rfc822_message_id text,

  attempts    smallint not null default 0,
  error_code  text,
  error_detail text,
  -- Why this send never happened: suppressed at dispatch, missing variable,
  -- mailbox gone, cancelled by a human.
  outcome_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint scheduled_sends_step_range check (step_number between 1 and 4),
  constraint scheduled_sends_touch_kind_matches
    check ((step_number = 1) = (touch_kind = 'first'))
);

-- The double-send guard. A lead may have at most one live row per step, where
-- "live" includes `sent`: that is what makes re-running the planner idempotent
-- and makes a duplicate T1 impossible rather than merely unlikely.
--
-- failed / cancelled / skipped are deliberately outside the index, so a send
-- that did not happen can be planned again.
create unique index scheduled_sends_lead_step_live
  on scheduled_sends (lead_id, step_number)
  where status in ('planned', 'blocked', 'claimed', 'sending', 'sent');

-- One Gmail message can only ever be one send.
create unique index scheduled_sends_provider_message_key
  on scheduled_sends (provider_message_id)
  where provider_message_id is not null;

-- The claimer's access path: due, planned, in this org.
create index scheduled_sends_due_idx
  on scheduled_sends (org_id, scheduled_at)
  where status = 'planned';

-- Cap accounting. Counts rows for one mailbox on one mailbox-local date.
create index scheduled_sends_cap_idx
  on scheduled_sends (mailbox_id, cap_date)
  where status in ('claimed', 'sending', 'sent');

create index scheduled_sends_lead_idx on scheduled_sends (lead_id, step_number);
create index scheduled_sends_org_status_idx on scheduled_sends (org_id, status);

create trigger scheduled_sends_set_updated_at before update on scheduled_sends
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- Guard: a lead with no timezone is never scheduled
-- ---------------------------------------------------------------------------
-- The planner already filters these out. This is here because that filter is
-- one WHERE clause in one route, and the rule it implements is the single most
-- expensive thing in this system to get wrong: a guessed zone puts a cold email
-- in front of somebody at 3am, and it does it silently.
--
-- Binding the service role too is deliberate, unlike the mailboxes guard. Every
-- writer of this table is a machine, so exempting machines would exempt
-- everyone.

create or replace function app.scheduled_sends_require_timezone()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.prospect_timezone is null or btrim(new.prospect_timezone) = '' then
    raise exception 'a scheduled send must carry the prospect timezone it was planned in'
      using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.leads l
     where l.id = new.lead_id and l.timezone is not null
  ) then
    raise exception
      'lead % has no resolvable timezone, so it is never scheduled', new.lead_id
      using errcode = '23514',
            hint = 'Assign a zone on the lead first. There is no state-to-zone '
                   'fallback anywhere in this system, on purpose.';
  end if;

  return new;
end;
$$;

-- Scoped to the columns that decide WHEN this send happens. Every insert is
-- checked; an update is only checked when it re-times the send. Without the
-- column list, clearing a lead's timezone would make its existing sends
-- impossible to cancel or mark failed, which is exactly backwards.
create trigger scheduled_sends_require_timezone
  before insert
      or update of scheduled_at, prospect_timezone, lead_id
      on scheduled_sends
  for each row execute function app.scheduled_sends_require_timezone();

-- ---------------------------------------------------------------------------
-- lead_events.scheduled_send_id
-- ---------------------------------------------------------------------------
-- The column has been on lead_events since 0003 with nothing to point at. Now
-- there is. ON DELETE SET NULL, and the append-only guard has to be told that
-- this particular UPDATE is the foreign key rather than an edit — exactly the
-- shape 0012 permitted for actor_id.

alter table lead_events
  add constraint lead_events_scheduled_send_fkey
  foreign key (scheduled_send_id) references scheduled_sends(id) on delete set null;

create or replace function app.block_event_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('app.allow_event_mutation', true), 'off') = 'on' then
    return coalesce(new, old);
  end if;

  -- The parent is already gone: this is a cascade, not a hand-written delete.
  if tg_op = 'DELETE'
     and (
       not exists (select 1 from public.leads l where l.id = old.lead_id)
       or not exists (select 1 from public.orgs o where o.id = old.org_id)
     )
  then
    return old;
  end if;

  -- The author is already gone: this is lead_events_actor_id_fkey.
  if tg_op = 'UPDATE'
     and old.actor_id is not null
     and new.actor_id is null
     and (to_jsonb(new) - 'actor_id') = (to_jsonb(old) - 'actor_id')
     and not exists (select 1 from auth.users u where u.id = old.actor_id)
  then
    return new;
  end if;

  -- The send row is already gone: this is lead_events_scheduled_send_fkey.
  -- Same shape as above, and same reasoning for comparing the rows as jsonb
  -- minus the one key rather than listing columns: a column added later cannot
  -- silently widen the hole.
  if tg_op = 'UPDATE'
     and old.scheduled_send_id is not null
     and new.scheduled_send_id is null
     and (to_jsonb(new) - 'scheduled_send_id') = (to_jsonb(old) - 'scheduled_send_id')
     and not exists (
       select 1 from public.scheduled_sends s where s.id = old.scheduled_send_id
     )
  then
    return new;
  end if;

  raise exception 'lead_events is append-only (attempted % on event %)',
    tg_op, coalesce(old.id::text, '?')
    using errcode = '0A000';
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Read-only to the browser. Every state change here is either the planner, the
-- claimer or the dispatcher, and a hand-written UPDATE that moved a row to
-- `sent` would fabricate a sent email that never existed. Cancelling is the one
-- thing a human does, and it goes through the RPC below.

alter table scheduled_sends enable row level security;

create policy scheduled_sends_select on scheduled_sends
  for select to authenticated
  using (org_id = app.current_org_id());

-- ---------------------------------------------------------------------------
-- Cancelling
-- ---------------------------------------------------------------------------

create or replace function public.cancel_scheduled_send(
  p_send_id uuid,
  p_reason  text default null
) returns public.scheduled_sends
language plpgsql security definer set search_path = '' as $$
declare
  v_org  uuid := app.current_org_id();
  v_send public.scheduled_sends;
begin
  if v_org is null then
    raise exception 'not a member of any org' using errcode = '42501';
  end if;

  -- Only a send that has not left yet. `claimed` and `sending` are excluded on
  -- purpose: by then the dispatcher may already be inside the Gmail call, and
  -- a row that says cancelled next to an email that went out is worse than a
  -- refusal.
  update public.scheduled_sends s
     set status = 'cancelled',
         outcome_reason = coalesce(p_reason, 'cancelled by operator')
   where s.id = p_send_id
     and s.org_id = v_org
     and s.status in ('planned', 'blocked')
  returning s.* into v_send;

  if not found then
    raise exception 'that send is not cancellable (it may already be on its way)'
      using errcode = '55006';
  end if;

  return v_send;
end;
$$;

revoke all on function public.cancel_scheduled_send(uuid, text) from public, anon;
grant execute on function public.cancel_scheduled_send(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
-- REPLICA IDENTITY FULL is not optional, and 0012 is the scar. Realtime
-- evaluates the subscriber's RLS policy against the changed row before
-- forwarding it; with the default identity the WAL record carries only the
-- primary key, there is nothing to evaluate scheduled_sends_select against, and
-- every change is dropped while the subscription still reports SUBSCRIBED.

alter table public.scheduled_sends replica identity full;
alter publication supabase_realtime add table public.scheduled_sends;
