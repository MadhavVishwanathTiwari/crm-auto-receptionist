-- Fix: the status-sync trigger was blocked by the protected-columns guard.
--
-- app.sync_lead_status_batch() updates leads.status, and
-- app.leads_guard_protected_columns() raises on any change to status unless
-- app.bypass_lead_guard is set. The claim RPCs set that flag, so claiming
-- worked; but any OTHER path that inserts an event — a service-role webhook
-- writing `sent`/`replied`, or a member writing an `audited` event — raised
-- "status is derived from lead_events, not written" and the whole INSERT
-- failed.
--
-- The sync trigger IS the legitimate writer of status, so it announces itself.
-- It saves and restores the previous flag value rather than leaving it on, so
-- the bypass cannot outlive this statement and let a later write in the same
-- transaction slip a hand-typed status past the guard.

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

  perform set_config('app.bypass_lead_guard', v_previous, true);
  return null;
end;
$$;
