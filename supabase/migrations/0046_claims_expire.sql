-- 0046: a claim that never reached Gmail goes back to the queue.
--
-- claim_due_sends() moves a row planned -> claimed. mark_send_sending() moves
-- it claimed -> sending immediately before the Gmail call, and only for the
-- caller holding the claim's token. Nothing else ever moved a row out of
-- `claimed`: reap_stalled_sends() looks at `sending` only, and the planner,
-- /write and repair_stalled_sends() all read `claimed` as "on its way, wait".
-- So a dispatcher that stopped between the two -- killed at its time limit
-- behind a slow token refresh, or refused by mark_send_sending() with an error
-- nobody read -- left a row that held its lead indefinitely, counted against
-- that day's cap, and was described on /write as an email about to go out.
--
-- A claimed row is safe to put back, and that is the whole difference from a
-- `sending` one. Gmail is only called after mark_send_sending() has turned the
-- row into `sending`, and that UPDATE requires the row to still be `claimed`
-- under the caller's token. Releasing it changes both, so a dispatcher still
-- holding the old claim is refused at the point of no return and never sends.
--
-- Back to `planned`, not `failed`: nothing happened to the prospect. If the
-- slot has passed by then, the planner rolls it forward like any missed slot.
-- The dispatcher calls this before claiming, the same place it reaps.

create or replace function public.release_expired_claims(p_org_id uuid)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_minutes int;
  v_count   int;
begin
  select stall_minutes into v_minutes
    from public.org_settings where org_id = p_org_id;
  if not found then
    return 0;
  end if;

  update public.scheduled_sends s
     set status         = 'planned',
         claim_token    = null,
         claimed_at     = null,
         -- It was counted against that day's cap when claimed. It no longer is.
         cap_date       = null,
         outcome_reason = 'claimed at '
                          || to_char(s.claimed_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI')
                          || ' UTC and never sent, so it went back to the queue'
   where s.org_id = p_org_id
     and s.status = 'claimed'
     and s.claimed_at < now() - make_interval(mins => v_minutes);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.release_expired_claims(uuid) is
  'Returns sends claimed more than stall_minutes ago, and never marked sending, to planned. Safe because mark_send_sending() is the only way to Gmail and it requires the claim.';

revoke all on function public.release_expired_claims(uuid) from public, anon, authenticated;
grant execute on function public.release_expired_claims(uuid) to service_role;
