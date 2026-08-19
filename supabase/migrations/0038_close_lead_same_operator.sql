-- close_lead() learns what 0032 taught the rest of the schema, and stops
-- overwriting an outcome it has already recorded.
--
-- WHAT IS ACTUALLY WRONG HERE, because it is not what it looks like.
--
-- 0004 wrote the ownership check as
--   (l.claimed_by is null or l.claimed_by = auth.uid() or app.is_admin())
-- and 0036 retrofitted app.same_operator into set_lead_stage() and
-- queue_lead_without_audit() without coming back for this one. close_lead is
-- now the only guarded write on leads still comparing user ids strictly.
--
-- It has never actually refused madhav anything, and that IS the problem. Both
-- of his addresses are seeded `admin` -- 0008 for @autoreceptionist.io, 0009
-- for @tryautoreceptionist.com -- so app.is_admin() is true for him on every
-- lead in the org and the strict comparison in front of it is unreachable. The
-- check is dead code that happens to be wrong, which is worse than a check that
-- is visibly wrong, because nothing fails until something unrelated changes.
--
-- Ojas is a `member`, and he is the one it refuses today on a lead either
-- madhav account claimed.
--
-- Two things make it worth fixing now:
--
--   1. It is one role change away from breaking. `member` is the correct role
--      for an operator -- 0032's whole argument is that ownership is not
--      adminship -- and the day madhav is demoted, every close on a lead his
--      OTHER account claimed starts raising 42501, with no code change to blame.
--   2. Closing is about to become one drag on /pipeline instead of a two-step
--      confirm at the bottom of the drawer. This path is about to be taken far
--      more often, by both operators, on leads either of them owns.
--
-- AND: a second close silently rewrote the first.
--
-- The UPDATE had no guard against terminal_outcome already being set, so
-- close_lead(id, 'closed_lost') on a lead already closed_won overwrote the
-- outcome and appended a second `closed` event, leaving a timeline that says
-- both. The drawer hides that by disabling its button, which is UI concealing a
-- reachable RPC rather than a rule. It matters more now: the board's three
-- terminal columns are about to become drop targets, and Won -> Lost is a
-- gesture anyone can perform by accident. Refused here, in the same shape and
-- with the same errcode set_lead_stage() uses for the same situation.
--
-- There is deliberately still no reopen. A terminal outcome beats every later
-- event in app.lead_status_from_events and the guard blocks clearing the
-- column; undoing one is a migration, and the hint says so.
--
-- Restated in full because `create or replace` swaps the whole body: a partial
-- copy would silently drop the guard bypass or the event insert.

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

  -- Read before writing, so "not yours" and "already closed" are
  -- distinguishable. 0004 folded ownership into the UPDATE's WHERE and could
  -- therefore only ever say "not found, or it belongs to someone else".
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

  if v_lead.terminal_outcome is not null then
    raise exception 'that lead is already closed as %', v_lead.terminal_outcome
      using errcode = '22023',
            hint = 'A terminal outcome is final. Changing one takes a migration, so that the timeline still says what happened.';
  end if;

  -- Transaction-local, and deliberately not restored, exactly as 0004 left it:
  -- PostgREST runs each RPC in its own transaction, so it ends with the request.
  perform set_config('app.bypass_lead_guard', 'on', true);

  update public.leads l
     set terminal_outcome = p_outcome
   where l.id = p_lead_id
     and l.org_id = v_org
  returning l.* into v_lead;

  if not found then
    raise exception 'lead not found, or it belongs to someone else'
      using errcode = '42501';
  end if;

  -- Inserting the event is what recomputes status, via 0004's trigger.
  insert into public.lead_events (org_id, lead_id, type, actor_id, payload)
  values (v_org, p_lead_id, 'closed', auth.uid(),
          jsonb_build_object('outcome', p_outcome, 'note', p_note));

  select * into v_lead from public.leads where id = p_lead_id;
  return v_lead;
end;
$$;

comment on function public.close_lead(uuid, terminal_outcome, text) is
  'Records a terminal outcome: writes terminal_outcome under the guard bypass, '
  'then a `closed` event. Ownership via app.same_operator, matching '
  'set_lead_stage since 0036. Refuses a lead already closed; there is no reopen.';

revoke all on function public.close_lead(uuid, terminal_outcome, text) from public, anon;
grant execute on function public.close_lead(uuid, terminal_outcome, text) to authenticated;
