-- Two guards were blocking the foreign keys that are supposed to clean up
-- after them. Both were found by trying to delete a test fixture and getting a
-- flat refusal; both are production bugs, not test hygiene.
--
--   1. `delete from orgs` fails with "lead_events is append-only". The org
--      cascades to leads, which cascades to lead_events, and the append-only
--      trigger refuses the cascaded DELETE. An org with any event in its
--      history could never be removed. This is also why the integration
--      harness's cleanup() has silently leaked its fixtures on every run since
--      it was written -- it deletes the org and ignores the error.
--
--   2. `delete from auth.users` fails with "ownership is managed by
--      claim_lead()". leads.claimed_by is ON DELETE SET NULL, and the guard
--      treats that cascade as an illegal hand-written ownership change. An
--      operator who had ever claimed a lead could never be offboarded.
--
-- Neither guard is being weakened. Both still reject exactly what they were
-- written to reject: a direct DELETE of an event whose lead is still there, and
-- a hand-rolled change of ownership.

-- ---------------------------------------------------------------------------
-- 1. Append-only, except when the parent is going away
-- ---------------------------------------------------------------------------
-- Postgres deletes the parent row before running the FK's referential action,
-- so during a cascade the parent is already invisible to this trigger's
-- snapshot. That absence is the signal, and it cannot be forged from a client:
-- a caller deleting an event directly leaves the lead in place, so the check
-- below still raises for them.
--
-- Both parents are tested. lead_events has cascading FKs to BOTH leads and
-- orgs, and when an org is dropped the order in which those two fire is not
-- guaranteed -- but the org row itself is always gone first, because it is the
-- root of the cascade.

create or replace function app.block_event_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('app.allow_event_mutation', true), 'off') = 'on' then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE'
     and (
       not exists (select 1 from public.leads l where l.id = old.lead_id)
       or not exists (select 1 from public.orgs o where o.id = old.org_id)
     )
  then
    return old;
  end if;

  raise exception 'lead_events is append-only (attempted % on event %)',
    tg_op, coalesce(old.id::text, '?')
    using errcode = '0A000';
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Ownership, except when the owner no longer exists
-- ---------------------------------------------------------------------------
-- Only the exact shape the FK produces is allowed through: claimed_by going
-- from a value to null, claim_count untouched, and no row left in auth.users
-- for the old owner. Anything else still routes through the RPCs.
--
-- The lead is put back in the pool properly while we are here. The FK only
-- nulls claimed_by, which would otherwise leave an unclaimed lead still
-- carrying the timestamp of a claim by somebody who no longer exists.

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

  -- A human editing the zone always marks it manual, so a later automated
  -- resolution pass cannot silently overwrite a correction. Clearing it puts
  -- the lead back in the unresolved pool, where it has no source either.
  if new.timezone is distinct from old.timezone then
    new.timezone_source :=
      case when new.timezone is null then null else 'manual' end;
  end if;

  new.updated_at := now();
  return new;
end;
$$;
