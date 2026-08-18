-- The half of the funnel that had no machinery.
--
-- Everything up to `replied` is built: import, claim, audit, write, schedule,
-- send, poll. Then poll-replies writes its event, the sequence halts, an alert
-- fires, and the app has nothing further to say. There is no way to record that
-- a call is booked, no note, no follow-up date, and no screen that shows which
-- conversations are open. The only move left for a lead that answered is
-- close_lead(): won, lost, or do-not-contact. Everything in between has been
-- living in somebody's head.
--
-- WHY A SECOND COLUMN AND NOT MORE lead_status VALUES
--
-- app.lead_status_from_events ranks event types and takes the maximum, so that
-- a late-arriving `delivered` webhook can never walk a replied lead backwards.
-- That monotonicity is correct for a machine log and it is the whole point of
-- 0004.
--
-- A sales stage is not monotonic. A no-show sends `meeting` back to `engaged`,
-- and a deal that goes quiet gets parked in `nurture` and pulled out again.
-- Ranking those would either break the guarantee for everything or lock every
-- deal permanently forward.
--
-- So there are two derived columns, both fed by the same event log:
--
--   leads.status   what the machine did       rank-ordered, forward only
--   leads.stage    where the human thinks      last write wins, any direction
--                  the deal is
--
-- Both stay derived and both stay guarded, so "status is derived, never typed"
-- is unchanged. The precedent for a human assertion outranking the log is
-- already here: terminal_outcome wins the coalesce in 0004.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
-- Every default is non-volatile, so none of these rewrites the table.

alter table leads
  add column stage            pipeline_stage not null default 'prospect',
  add column stage_changed_at timestamptz,
  add column next_action      text,
  add column next_action_at   timestamptz,
  add column deal_value       numeric(12, 2);

-- NULL means "the org default", which is what makes a pipeline total real
-- without anybody typing the same number onto every lead. The override exists
-- for the deal that genuinely differs. A column everyone has to maintain is a
-- column that goes stale, and a stale number on a board is worse than no
-- number at all.
comment on column leads.deal_value is
  'What this deal is worth. NULL means org_settings.default_deal_value; set it '
  'only where the amount actually differs.';

comment on column leads.stage is
  'Where the operator thinks the deal is. Derived from stage_changed events by '
  'app.lead_stage_from_events, last write wins. Orthogonal to status, which is '
  'what the machine did. Won/lost/DNC are terminal_outcome, not stages.';

comment on column leads.next_action is
  'The one thing to do next for this lead, replaced when it is done. Not a task '
  'table: two operators and one open thread per lead do not need one.';

alter table org_settings
  add column default_deal_value numeric(12, 2) not null default 997;

comment on column org_settings.default_deal_value is
  'What a deal is worth when leads.deal_value is null, which is almost always.';

-- ---------------------------------------------------------------------------
-- 2. Deriving stage from the event log
-- ---------------------------------------------------------------------------
-- Unlike app.lead_status_from_events this is LAST WRITE WINS, not ranked. That
-- is the entire difference between the two columns and it is deliberate.
--
-- The `replied` fallback is what makes the board populate itself: a reply lands,
-- poll-replies writes its event, and the card appears under Engaged with nobody
-- doing bookkeeping. It is only a fallback, checked after any explicit move, so
-- a lead an operator has parked in `nurture` does not get yanked back to
-- `engaged` by a later reply. The operator sees that reply as an alert and
-- decides for themselves, which is the right place for that judgement.

create or replace function app.lead_stage_from_events(p_lead_id uuid)
returns table (stage public.pipeline_stage, changed_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with latest as (
    select
      (e.payload->>'to')::public.pipeline_stage as stage,
      e.occurred_at
    from public.lead_events e
    where e.lead_id = p_lead_id
      and e.type = 'stage_changed'
      and e.payload->>'to' is not null
    -- created_at breaks the tie when two moves share a timestamp, which is what
    -- a backfill inserting a whole history in one statement produces.
    order by e.occurred_at desc, e.created_at desc
    limit 1
  )
  select
    coalesce(
      (select l.stage from latest l),
      (select 'engaged'::public.pipeline_stage
         from public.lead_events e
        where e.lead_id = p_lead_id and e.type = 'replied'
        limit 1),
      'prospect'::public.pipeline_stage
    ),
    (select l.occurred_at from latest l);
$$;

comment on function app.lead_stage_from_events(uuid) is
  'Single source of truth for lead stage. Last write wins, so a stage can move '
  'backwards - which is the difference from lead_status_from_events, not an '
  'oversight. Pure and safe to re-run over the full event set.';

-- ---------------------------------------------------------------------------
-- 3. The sync trigger now derives both
-- ---------------------------------------------------------------------------
-- One statement-level pass over the transition table, one UPDATE. Splitting
-- this into a second trigger would double the work on a 1000-row import for no
-- benefit, and the bypass save/restore from 0006 already covers both columns.

create or replace function app.sync_lead_status_batch() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_previous text;
begin
  v_previous := coalesce(current_setting('app.bypass_lead_guard', true), 'off');
  perform set_config('app.bypass_lead_guard', 'on', true);

  with touched as (
    select distinct lead_id from inserted
  ),
  computed as (
    select t.lead_id, d.status, d.halted_at, d.halt_reason,
           s.stage, s.changed_at
      from touched t
      cross join lateral app.lead_status_from_events(t.lead_id) d
      cross join lateral app.lead_stage_from_events(t.lead_id) s
  )
  update public.leads l
     set status            = c.status,
         status_updated_at = now(),
         halted_at         = c.halted_at,
         halt_reason       = c.halt_reason,
         stage             = c.stage,
         stage_changed_at  = c.changed_at
    from computed c
   where l.id = c.lead_id
     and (l.status           is distinct from c.status
       or l.halted_at        is distinct from c.halted_at
       or l.stage            is distinct from c.stage
       or l.stage_changed_at is distinct from c.changed_at);

  perform set_config('app.bypass_lead_guard', v_previous, true);
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The guard learns about stage
-- ---------------------------------------------------------------------------
-- 0029 verbatim plus one branch. Restated in full because `create or replace`
-- replaces the whole body and a partial copy here would silently drop the rest
-- of the protections.
--
-- next_action, next_action_at and deal_value are deliberately NOT guarded. They
-- are ordinary human fields written by a plain UPDATE under leads_update, in
-- exactly the way `timezone` already is. Only the derived columns need a guard.

create or replace function app.leads_guard_protected_columns() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_owner_deleted boolean;
begin
  if coalesce(current_setting('app.bypass_lead_guard', true), 'off') = 'on' then
    new.updated_at := now();
    return new;
  end if;

  if new.org_id is distinct from old.org_id then
    raise exception 'org_id is immutable' using errcode = '42501';
  end if;

  if new.status is distinct from old.status
     or new.terminal_outcome is distinct from old.terminal_outcome
     or new.halted_at is distinct from old.halted_at
     or new.halt_reason is distinct from old.halt_reason then
    raise exception
      'status is derived from lead_events, not written. Insert an event instead.'
      using errcode = '42501';
  end if;

  if new.stage is distinct from old.stage
     or new.stage_changed_at is distinct from old.stage_changed_at then
    raise exception
      'stage is derived from lead_events, not written. Use set_lead_stage().'
      using errcode = '42501';
  end if;

  if new.claimed_by is distinct from old.claimed_by
     or new.claimed_at is distinct from old.claimed_at
     or new.claim_count is distinct from old.claim_count then

    v_owner_deleted :=
      new.claimed_by is null
      and old.claimed_by is not null
      and new.claim_count = old.claim_count
      and not exists (select 1 from auth.users u where u.id = old.claimed_by);

    if v_owner_deleted then
      new.claimed_at  := null;
      new.released_at := now();
    else
      raise exception
        'ownership is managed by claim_lead() / release_lead() / reassign_lead()'
        using errcode = '42501';
    end if;
  end if;

  if new.demo_txt_url is distinct from old.demo_txt_url
     or new.demo_web_url is distinct from old.demo_web_url
     or new.demo_slug is distinct from old.demo_slug
     or new.demo_ready_at is distinct from old.demo_ready_at then
    raise exception 'demo URLs are written by the demo ingest API'
      using errcode = '42501';
  end if;

  if new.timezone is distinct from old.timezone then
    if new.timezone is null then
      new.timezone_source := null;
    elsif old.timezone is null
      and new.timezone_source in ('coordinates', 'place', 'import') then
      -- Filling a hole, and the writer said how. Believe it.
      null;
    else
      -- Changing an existing zone is a human overriding one, whoever asked.
      new.timezone_source := 'manual';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Moving a lead
-- ---------------------------------------------------------------------------

create or replace function public.set_lead_stage(
  p_lead_id uuid,
  p_stage   pipeline_stage,
  p_note    text default null
) returns public.leads
language plpgsql security definer set search_path = '' as $$
declare
  v_org  uuid := app.current_org_id();
  v_lead public.leads;
begin
  if v_org is null then
    raise exception 'not a member of any org' using errcode = '42501';
  end if;

  -- Definer bypasses RLS, so the org predicate is written by hand.
  select * into v_lead
    from public.leads l
   where l.id = p_lead_id
     and l.org_id = v_org;

  if not found then
    raise exception 'no such lead' using errcode = '22023';
  end if;

  -- app.same_operator rather than claimed_by = auth.uid(), which is the 0032
  -- lesson: madhav holds two accounts in this org, one that connected the
  -- mailbox and one that claimed the leads. A strict comparison refuses every
  -- lead he owns while working perfectly for Ojas, which is a worse bug than
  -- the one being fixed.
  if not (v_lead.claimed_by is null
          or app.same_operator(v_lead.claimed_by, auth.uid())
          or app.is_admin()) then
    raise exception 'that lead belongs to somebody else' using errcode = '42501';
  end if;

  if v_lead.terminal_outcome is not null then
    raise exception 'that lead is closed'
      using errcode = '22023',
            hint = 'A closed lead has no stage to move. Its outcome is final.';
  end if;

  -- Already there. Returning quietly rather than writing an event that says
  -- nothing happened keeps the timeline worth reading.
  if v_lead.stage = p_stage then
    return v_lead;
  end if;

  insert into public.lead_events (org_id, lead_id, type, actor_id, payload)
  values (v_org, p_lead_id, 'stage_changed', auth.uid(),
          jsonb_build_object(
            'from', v_lead.stage,
            'to',   p_stage,
            'note', nullif(btrim(coalesce(p_note, '')), '')));

  -- The trigger above recomputed it; re-read rather than guessing.
  select * into v_lead from public.leads where id = p_lead_id;
  return v_lead;
end;
$$;

comment on function public.set_lead_stage(uuid, pipeline_stage, text) is
  'Moves a lead to a pipeline stage by writing a stage_changed event. Any '
  'direction. Refuses a closed lead, and one that belongs to somebody else.';

revoke all on function public.set_lead_stage(uuid, pipeline_stage, text) from public, anon;
grant execute on function public.set_lead_stage(uuid, pipeline_stage, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. "Send without an audit", which has never worked
-- ---------------------------------------------------------------------------
-- 0022 designed this around a `queued` event and says the leads screen "now
-- writes" one. It does - through the cookie-bound RLS client. But
-- lead_events_insert permits only ('audited', 'note', 'manual_override'), so
-- every one of those inserts was rejected and the button has never worked for
-- anybody.
--
-- Worth being exact about the mechanism, because the action was written for the
-- wrong one: a `with check` violation on INSERT raises 42501 outright. The
-- silent 204-with-zero-rows case is UPDATE and DELETE, where a `using` clause
-- filters the row out before there is anything left to violate. So the operator
-- got Postgres's own "new row violates row-level security policy for table
-- lead_events", and the friendlier zero-row branch underneath it was dead code.
--
-- Fixed here rather than by widening the policy. lead_events_insert checks
-- org_id and nothing else, so adding `queued` to it would let either operator
-- queue the other's leads. Ownership checks belong in a definer function, which
-- is where every other guarded write in this schema does them.

create or replace function public.queue_lead_without_audit(p_lead_id uuid)
returns public.leads
language plpgsql security definer set search_path = '' as $$
declare
  v_org  uuid := app.current_org_id();
  v_lead public.leads;
begin
  if v_org is null then
    raise exception 'not a member of any org' using errcode = '42501';
  end if;

  select * into v_lead
    from public.leads l
   where l.id = p_lead_id
     and l.org_id = v_org;

  if not found then
    raise exception 'no such lead' using errcode = '22023';
  end if;

  if not (v_lead.claimed_by is null
          or app.same_operator(v_lead.claimed_by, auth.uid())
          or app.is_admin()) then
    raise exception 'that lead belongs to somebody else' using errcode = '42501';
  end if;

  -- A fixed dedupe_token against the unique (lead_id, type, dedupe_token), so
  -- pressing the button twice is the same as pressing it once. A null token
  -- would not dedupe: nulls are distinct in a unique index.
  insert into public.lead_events (org_id, lead_id, type, actor_id, payload, dedupe_token)
  values (v_org, p_lead_id, 'queued', auth.uid(),
          jsonb_build_object('reason', 'queued without an audit'), 'manual')
  on conflict (lead_id, type, dedupe_token) do nothing;

  select * into v_lead from public.leads where id = p_lead_id;
  return v_lead;
end;
$$;

comment on function public.queue_lead_without_audit(uuid) is
  'Marks a lead sendable without an audit by writing a `queued` event. '
  'Idempotent. Replaces a direct insert that lead_events_insert always refused.';

revoke all on function public.queue_lead_without_audit(uuid) from public, anon;
grant execute on function public.queue_lead_without_audit(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Indexes
-- ---------------------------------------------------------------------------
-- org_id leads, as everywhere else on this table, and both are partial because
-- both queries are.

create index leads_org_stage_idx on leads (org_id, stage)
  where archived_at is null;

create index leads_next_action_idx on leads (org_id, next_action_at)
  where next_action_at is not null and archived_at is null;

-- Realtime needs nothing: `leads` has been published with replica identity full
-- since 0010/0012, so a stage move reaches the board on its own.
