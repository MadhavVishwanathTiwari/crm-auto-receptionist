-- Status derivation and the two write guards that make "derived, never typed"
-- a property of the database rather than a convention the app agrees to follow.

-- ---------------------------------------------------------------------------
-- Deriving status from the event log
-- ---------------------------------------------------------------------------
-- Recomputes from the WHOLE event set rather than incrementally, so it is
-- order-independent and replay-safe: a webhook that delivers a `delivered`
-- event after a `replied` one cannot walk the status backwards.

create or replace function app.lead_status_from_events(p_lead_id uuid)
returns table (status public.lead_status, halted_at timestamptz, halt_reason text)
language sql stable security definer set search_path = '' as $$
  with e as (
    select
      type,
      occurred_at,
      case type
        when 'imported'     then 10
        when 'qualified'    then 20
        when 'claimed'      then 30
        when 'audited'      then 40
        when 'queued'       then 50
        when 'sent'         then 60
        when 'delivered'    then 70
        when 'opened'       then 80
        when 'replied'      then 90
        when 'bounced'      then 92
        when 'unsubscribed' then 95
        -- Rank 0 never advances status:
        --   demo_ready   is a CAPABILITY, not a stage. If it advanced status, a
        --                demo arriving for a lead already at `sent` would make
        --                the pipeline visibly go backwards. Readiness lives in
        --                leads.demo_ready_at, which is what gates step T2.
        --   released /
        --   reassigned   change ownership, not progress.
        --   disqualified is an audit marker. A lead that never earns a
        --                `qualified` event simply stays `imported`; an
        --                explicitly rejected one is closed with a
        --                terminal_outcome instead.
        --   closed       is handled by terminal_outcome below.
        --   note /
        --   manual_override are commentary.
        else 0
      end as rank
    from public.lead_events
    where lead_id = p_lead_id
  ),
  -- A reply, bounce or unsubscribe halts the remaining sequence immediately.
  halt as (
    select
      min(occurred_at) as at,
      (array_agg(type order by occurred_at))[1]::text as reason
    from e
    where type in ('replied', 'bounced', 'unsubscribed')
  ),
  top as (
    select type from e where rank > 0 order by rank desc, occurred_at desc limit 1
  )
  select
    coalesce(
      -- A human-asserted outcome wins over everything, and stays won against a
      -- late-arriving provider webhook.
      (select l.terminal_outcome::text::public.lead_status
         from public.leads l
        where l.id = p_lead_id and l.terminal_outcome is not null),
      (select t.type::text::public.lead_status from top t),
      'imported'::public.lead_status
    ),
    (select at from halt),
    (select reason from halt);
$$;

comment on function app.lead_status_from_events(uuid) is
  'Single source of truth for lead status. Pure, order-independent, and safe to '
  're-run over the full event set at any time — which is what the nightly '
  'reconcile job does to catch drift in the cached leads.status column.';

-- Statement-level, with a transition table, so a 1000-row import fires it once
-- instead of a thousand times.
create or replace function app.sync_lead_status_batch() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  with touched as (
    select distinct lead_id from inserted
  ),
  computed as (
    select t.lead_id, d.status, d.halted_at, d.halt_reason
      from touched t
      cross join lateral app.lead_status_from_events(t.lead_id) d
  )
  update public.leads l
     set status            = c.status,
         status_updated_at = now(),
         halted_at         = c.halted_at,
         halt_reason       = c.halt_reason
    from computed c
   where l.id = c.lead_id
     and (l.status    is distinct from c.status
       or l.halted_at is distinct from c.halted_at);

  return null;
end;
$$;

create trigger lead_events_sync_status
  after insert on lead_events
  referencing new table as inserted
  for each statement execute function app.sync_lead_status_batch();

-- ---------------------------------------------------------------------------
-- Guard 1: lead_events is append-only
-- ---------------------------------------------------------------------------
-- Enforced by a trigger rather than by withholding UPDATE/DELETE policies,
-- because policies do not bind service_role. The break-glass is an explicit
-- set_config, which shows up in a migration diff instead of happening quietly.

create or replace function app.block_event_mutation() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.allow_event_mutation', true), 'off') <> 'on' then
    raise exception 'lead_events is append-only (attempted % on event %)',
      tg_op, coalesce(old.id::text, '?')
      using errcode = '0A000';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger lead_events_no_update before update on lead_events
  for each row execute function app.block_event_mutation();
create trigger lead_events_no_delete before delete on lead_events
  for each row execute function app.block_event_mutation();

-- ---------------------------------------------------------------------------
-- Guard 2: system-managed columns on leads
-- ---------------------------------------------------------------------------
-- RLS is row-level; it cannot express "this user may edit these columns but not
-- those". A column-level REVOKE would work for `status` alone but breaks
-- `select *` under PostgREST once you revoke SELECT, and says nothing useful in
-- the error. A BEFORE UPDATE trigger covers every managed column at once and
-- can point the caller at the right RPC.

create or replace function app.leads_guard_protected_columns() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- The RPCs that legitimately move these columns set this flag first. It is
  -- transaction-scoped (set_config(..., true)), so it cannot leak to the next
  -- statement on a pooled connection.
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

  if new.claimed_by is distinct from old.claimed_by
     or new.claimed_at is distinct from old.claimed_at
     or new.claim_count is distinct from old.claim_count then
    raise exception
      'ownership is managed by claim_lead() / release_lead() / reassign_lead()'
      using errcode = '42501';
  end if;

  if new.demo_txt_url is distinct from old.demo_txt_url
     or new.demo_web_url is distinct from old.demo_web_url
     or new.demo_slug is distinct from old.demo_slug
     or new.demo_ready_at is distinct from old.demo_ready_at then
    raise exception 'demo URLs are written by the demo ingest API'
      using errcode = '42501';
  end if;

  -- A human editing the zone always marks it manual, so a later automated
  -- resolution pass cannot silently overwrite a correction.
  if new.timezone is distinct from old.timezone then
    new.timezone_source := 'manual';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger leads_guard_protected before update on leads
  for each row execute function app.leads_guard_protected_columns();

-- ---------------------------------------------------------------------------
-- Recording a terminal outcome
-- ---------------------------------------------------------------------------
-- The one path by which a human sets status directly — and even it goes
-- through the event log, so the timeline stays complete.

create or replace function public.close_lead(
  p_lead_id uuid,
  p_outcome terminal_outcome,
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

  perform set_config('app.bypass_lead_guard', 'on', true);

  update public.leads l
     set terminal_outcome = p_outcome
   where l.id = p_lead_id
     and l.org_id = v_org
     and (l.claimed_by is null or l.claimed_by = auth.uid() or app.is_admin())
  returning l.* into v_lead;

  if not found then
    raise exception 'lead not found, or it belongs to someone else'
      using errcode = '42501';
  end if;

  -- Inserting the event is what recomputes status, via the trigger above.
  insert into public.lead_events (org_id, lead_id, type, actor_id, payload)
  values (v_org, p_lead_id, 'closed', auth.uid(),
          jsonb_build_object('outcome', p_outcome, 'note', p_note));

  select * into v_lead from public.leads where id = p_lead_id;
  return v_lead;
end;
$$;

revoke all on function public.close_lead(uuid, terminal_outcome, text) from public, anon;
grant execute on function public.close_lead(uuid, terminal_outcome, text) to authenticated;
