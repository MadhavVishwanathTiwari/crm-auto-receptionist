-- Orgs, membership, roles, and the two helper functions every RLS policy in
-- this database is built on.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table orgs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table org_members (
  org_id     uuid not null references orgs(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       org_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id),

  -- One org per user, for now. This is what lets app.current_org_id() return a
  -- scalar instead of a set, which in turn keeps every policy a simple equality
  -- test. Multi-org membership is a later migration that drops this constraint
  -- and moves the org into a request header or JWT claim; nothing else in the
  -- schema assumes single-tenancy.
  unique (user_id)
);

create index org_members_org_idx on org_members (org_id);

create table org_settings (
  org_id               uuid primary key references orgs(id) on delete cascade,

  -- Send window, prospect-local. Ends are EXCLUSIVE: 07:00-11:00 means the last
  -- eligible start is 10:59. Mon-Fri, 7 hours a day.
  morning_start_hour   smallint not null default 7,
  morning_end_hour     smallint not null default 11,
  afternoon_start_hour smallint not null default 13,
  afternoon_end_hour   smallint not null default 16,

  -- How far ahead the planner will search before giving up and marking a send
  -- 'blocked' with a cap_exhausted alert.
  max_lookahead_days   smallint not null default 30,

  -- A due send older than this is invisible to the claimer and gets re-planned
  -- forward instead. This is what implements "missed slots roll forward, never
  -- send outside the window to catch up".
  slot_grace_minutes   smallint not null default 20,

  -- Phase 1 kill switch. claim_due_sends() refuses to return anything while
  -- this is true, so the app physically cannot send even if a dispatcher were
  -- deployed by accident.
  dry_run              boolean not null default true,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint org_settings_morning_window check (morning_start_hour < morning_end_hour),
  constraint org_settings_afternoon_window check (afternoon_start_hour < afternoon_end_hour),
  constraint org_settings_windows_ordered check (morning_end_hour <= afternoon_start_hour)
);

create trigger orgs_set_updated_at before update on orgs
  for each row execute function app.set_updated_at();
create trigger org_settings_set_updated_at before update on org_settings
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER is load-bearing, not a convenience.
--
-- As SECURITY INVOKER, app.current_org_id() would query org_members, which
-- would evaluate org_members' RLS policy, which calls app.current_org_id() —
-- infinite recursion, and the single most common way a Supabase multi-tenant
-- schema locks itself out. Running as the table owner breaks the cycle.
--
-- They are also zero-argument and STABLE, so the planner hoists them into an
-- InitPlan: `where org_id = app.current_org_id()` evaluates the function once
-- per statement, not once per row. That is why the org is not carried in a JWT
-- claim — the performance argument for doing so disappears, and a custom access
-- token hook would add a stale-claim window after a role change.
--
-- Note these tables use ENABLE (not FORCE) row level security precisely so the
-- definer, which owns them, can read through the policy.

create or replace function app.current_org_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select m.org_id from public.org_members m where m.user_id = auth.uid();
$$;

create or replace function app.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.org_members m
     where m.user_id = auth.uid() and m.role = 'admin'
  );
$$;

revoke all on function app.current_org_id() from public, anon;
revoke all on function app.is_admin() from public, anon;
grant execute on function app.current_org_id() to authenticated, service_role;
grant execute on function app.is_admin() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Deny by default. Every policy targets `authenticated` explicitly, so `anon`
-- matches nothing anywhere and is denied by omission rather than by a rule
-- someone could delete.

alter table orgs         enable row level security;
alter table org_members  enable row level security;
alter table org_settings enable row level security;

-- Orgs: readable by members, mutable by admins. No insert policy — orgs are
-- created server-side during onboarding, not by a browser.
create policy orgs_select on orgs
  for select to authenticated
  using (id = app.current_org_id());

create policy orgs_update on orgs
  for update to authenticated
  using (id = app.current_org_id() and app.is_admin())
  with check (id = app.current_org_id() and app.is_admin());

-- Membership: everyone in the org can see who else is in it (the grid shows
-- "claimed by Ojas", which needs a name). Only admins change roles.
create policy org_members_select on org_members
  for select to authenticated
  using (org_id = app.current_org_id());

create policy org_members_write on org_members
  for all to authenticated
  using (org_id = app.current_org_id() and app.is_admin())
  with check (org_id = app.current_org_id() and app.is_admin());

-- Settings: readable by all members (the scheduler UI shows the window),
-- writable by admins.
create policy org_settings_select on org_settings
  for select to authenticated
  using (org_id = app.current_org_id());

create policy org_settings_update on org_settings
  for update to authenticated
  using (org_id = app.current_org_id() and app.is_admin())
  with check (org_id = app.current_org_id() and app.is_admin());
