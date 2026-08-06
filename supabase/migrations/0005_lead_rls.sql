-- RLS for the lead tables, and the RPCs that own claiming.

alter table leads         enable row level security;
alter table lead_events   enable row level security;
alter table lead_evidence enable row level security;
alter table suppressions  enable row level security;

-- ---------------------------------------------------------------------------
-- leads
-- ---------------------------------------------------------------------------
-- Leads belong to the ORG, not the user. Both operators see everything; an
-- unclaimed lead is a shared pool either may edit, and a claimed one is
-- writable only by its owner. The other user still SELECTs it — the grid shows
-- the whole pipeline — but their writes are filtered out.

create policy leads_select on leads
  for select to authenticated
  using (org_id = app.current_org_id());

create policy leads_insert on leads
  for insert to authenticated
  with check (org_id = app.current_org_id());

create policy leads_update on leads
  for update to authenticated
  using (
    org_id = app.current_org_id()
    and archived_at is null
    and (claimed_by is null or claimed_by = auth.uid() or app.is_admin())
  )
  with check (
    org_id = app.current_org_id()
    and (claimed_by is null or claimed_by = auth.uid() or app.is_admin())
  );

-- No DELETE policy. Leads are archived (archived_at), never removed, because
-- deleting one would take its event log and evidence with it.

-- ---------------------------------------------------------------------------
-- lead_events
-- ---------------------------------------------------------------------------

create policy lead_events_select on lead_events
  for select to authenticated
  using (org_id = app.current_org_id());

-- A member may author only the three human event types. Everything that
-- represents a machine observation — sent, delivered, replied, bounced,
-- demo_ready — is inserted by an RPC or by the service role, so a browser
-- cannot fabricate a pipeline state.
create policy lead_events_insert on lead_events
  for insert to authenticated
  with check (
    org_id = app.current_org_id()
    and actor_id = auth.uid()
    and type in ('audited', 'note', 'manual_override')
    and exists (
      select 1 from leads l
       where l.id = lead_id and l.org_id = app.current_org_id()
    )
  );

-- No update/delete policies, plus a hard REVOKE. The trigger in 0004 is the
-- real guarantee (it binds service_role too); this closes the PostgREST path.
revoke update, delete on lead_events from authenticated;

-- ---------------------------------------------------------------------------
-- lead_evidence
-- ---------------------------------------------------------------------------

create policy lead_evidence_select on lead_evidence
  for select to authenticated
  using (org_id = app.current_org_id());

create policy lead_evidence_insert on lead_evidence
  for insert to authenticated
  with check (
    org_id = app.current_org_id()
    and created_by = auth.uid()
    and exists (
      select 1 from leads l
       where l.id = lead_id
         and l.org_id = app.current_org_id()
         and (l.claimed_by is null or l.claimed_by = auth.uid() or app.is_admin())
    )
  );

create policy lead_evidence_update on lead_evidence
  for update to authenticated
  using (org_id = app.current_org_id() and (created_by = auth.uid() or app.is_admin()))
  with check (org_id = app.current_org_id());

create policy lead_evidence_delete on lead_evidence
  for delete to authenticated
  using (org_id = app.current_org_id() and (created_by = auth.uid() or app.is_admin()));

-- ---------------------------------------------------------------------------
-- suppressions
-- ---------------------------------------------------------------------------
-- Either operator may add one: "never contact these people again" is a safety
-- mechanism and should never need an admin to be online. Removal is admin-only,
-- because taking someone off the do-not-contact list is the dangerous direction.

create policy suppressions_select on suppressions
  for select to authenticated
  using (org_id = app.current_org_id());

create policy suppressions_insert on suppressions
  for insert to authenticated
  with check (org_id = app.current_org_id() and created_by = auth.uid());

create policy suppressions_delete on suppressions
  for delete to authenticated
  using (org_id = app.current_org_id() and app.is_admin());

-- ---------------------------------------------------------------------------
-- Claiming
-- ---------------------------------------------------------------------------

create or replace function public.claim_lead(p_lead_id uuid)
returns public.leads
language plpgsql security definer set search_path = '' as $$
declare
  v_org  uuid := app.current_org_id();
  v_lead public.leads;
begin
  if v_org is null then
    raise exception 'not a member of any org' using errcode = '42501';
  end if;

  perform set_config('app.bypass_lead_guard', 'on', true);

  -- The single conditional UPDATE is the entire concurrency control, and it is
  -- sufficient. Under READ COMMITTED, when two sessions target this row the
  -- second blocks on the row lock; when the first commits, Postgres re-checks
  -- the second's WHERE clause against the NEW row version (EvalPlanQual).
  -- claimed_by is no longer null, the row stops qualifying, zero rows update.
  -- No SELECT ... FOR UPDATE is needed for a single known row, and read-then-
  -- write would be a race.
  update public.leads l
     set claimed_by  = auth.uid(),
         claimed_at  = now(),
         released_at = null,
         claim_count = l.claim_count + 1
   where l.id = p_lead_id
     and l.org_id = v_org
     and l.claimed_by is null
     and l.archived_at is null
  returning l.* into v_lead;

  if not found then
    raise exception 'lead is already claimed' using errcode = '55006';
  end if;

  insert into public.lead_events (org_id, lead_id, type, actor_id, payload)
  values (v_org, p_lead_id, 'claimed', auth.uid(),
          jsonb_build_object('claim_count', v_lead.claim_count));

  return v_lead;
end;
$$;

create or replace function public.claim_leads_from_pool(p_limit int default 25)
returns setof public.leads
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
begin
  if v_org is null then
    raise exception 'not a member of any org' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'p_limit must be between 1 and 500' using errcode = '22023';
  end if;

  perform set_config('app.bypass_lead_guard', 'on', true);

  return query
  with candidates as (
    select l.id
      from public.leads l
     where l.org_id = v_org
       and l.claimed_by is null
       and l.archived_at is null
       and l.is_qualified
     order by l.lead_score desc nulls last, l.created_at
     limit p_limit
     -- SKIP LOCKED so two operators bulk-claiming at once take disjoint sets
     -- instead of one blocking on the other.
     for update of l skip locked
  ),
  updated as (
    update public.leads l
       set claimed_by  = auth.uid(),
           claimed_at  = now(),
           released_at = null,
           claim_count = l.claim_count + 1
     where l.id in (select id from candidates)
    returning l.*
  ),
  -- Data-modifying CTEs always execute to completion even when the primary
  -- query does not reference them, so this is not dead code.
  events as (
    insert into public.lead_events (org_id, lead_id, type, actor_id)
    select v_org, u.id, 'claimed', auth.uid() from updated u
    returning 1
  )
  select * from updated;
end;
$$;

create or replace function public.release_lead(p_lead_id uuid)
returns public.leads
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
     set claimed_by = null, claimed_at = null, released_at = now()
   where l.id = p_lead_id
     and l.org_id = v_org
     and (l.claimed_by = auth.uid() or app.is_admin())
  returning l.* into v_lead;

  if not found then
    raise exception 'lead is not yours to release' using errcode = '42501';
  end if;

  insert into public.lead_events (org_id, lead_id, type, actor_id)
  values (v_org, p_lead_id, 'released', auth.uid());

  return v_lead;
end;
$$;

create or replace function public.reassign_lead(p_lead_id uuid, p_to_user uuid)
returns public.leads
language plpgsql security definer set search_path = '' as $$
declare
  v_org  uuid := app.current_org_id();
  v_lead public.leads;
begin
  if v_org is null or not app.is_admin() then
    raise exception 'only an admin may reassign a lead' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.org_members m
     where m.org_id = v_org and m.user_id = p_to_user
  ) then
    raise exception 'target user is not a member of this org' using errcode = '42501';
  end if;

  perform set_config('app.bypass_lead_guard', 'on', true);

  update public.leads l
     set claimed_by = p_to_user, claimed_at = now(), released_at = null
   where l.id = p_lead_id and l.org_id = v_org
  returning l.* into v_lead;

  if not found then
    raise exception 'lead not found' using errcode = '42501';
  end if;

  insert into public.lead_events (org_id, lead_id, type, actor_id, payload)
  values (v_org, p_lead_id, 'reassigned', auth.uid(),
          jsonb_build_object('to_user', p_to_user));

  return v_lead;
end;
$$;

revoke all on function public.claim_lead(uuid) from public, anon;
revoke all on function public.claim_leads_from_pool(int) from public, anon;
revoke all on function public.release_lead(uuid) from public, anon;
revoke all on function public.reassign_lead(uuid, uuid) from public, anon;

grant execute on function public.claim_lead(uuid) to authenticated;
grant execute on function public.claim_leads_from_pool(int) to authenticated;
grant execute on function public.release_lead(uuid) to authenticated;
grant execute on function public.reassign_lead(uuid, uuid) to authenticated;
