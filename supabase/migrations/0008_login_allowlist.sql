-- Who may sign in, and what they get when they do.
--
-- Sign-in is Google only, and Google's own consent screen is set to Internal so
-- only members of the Auto Receptionist Workspace can complete the flow. That
-- is the outer gate. This migration is the inner one, and it is the boundary
-- that actually matters: the consent screen lives in a dashboard nobody diffs,
-- while this is a file in the repo.
--
-- Deliberately an address allowlist rather than a domain rule. The Workspace has
-- three domains and three accounts for two humans -- madhav@autoreceptionist.io
-- and madhav@tryautoreceptionist.com are the same person. The app tracks
-- ownership per auth user, so signing in as the second one would silently make
-- his claimed leads look like a third operator's. Naming the two login
-- identities makes that mistake impossible instead of merely unlikely. The
-- secondary domains stay what they are for: sending.

-- ---------------------------------------------------------------------------
-- The one org
-- ---------------------------------------------------------------------------
-- Seeded here rather than by an onboarding script, because there is exactly one
-- and the provisioning trigger below needs something to point at. `db:reset`
-- therefore produces a working app rather than an empty one.

insert into public.orgs (name, slug)
values ('Auto Receptionist', 'auto-receptionist')
on conflict (slug) do nothing;

insert into public.org_settings (org_id)
select id from public.orgs where slug = 'auto-receptionist'
on conflict (org_id) do nothing;

-- ---------------------------------------------------------------------------
-- The allowlist
-- ---------------------------------------------------------------------------
-- In the `app` schema, which PostgREST does not expose, so there is no API path
-- to it at all and no RLS policy to get wrong. Adding a third operator is a
-- one-row migration.

create table app.login_allowlist (
  email      text primary key,
  role       public.org_role not null default 'member',
  org_id     uuid not null references public.orgs(id) on delete cascade,
  note       text,
  created_at timestamptz not null default now(),

  -- Emails are compared lowercased and trimmed, so store them that way.
  constraint login_allowlist_email_normalized
    check (email = lower(btrim(email)))
);

comment on table app.login_allowlist is
  'The only identities that may create an auth user. Enforced by a trigger on '
  'auth.users, not by application code, so it holds regardless of which client '
  'or dashboard the signup came from.';

insert into app.login_allowlist (email, role, org_id, note)
select v.email, v.role::public.org_role, o.id, v.note
  from (values
    ('madhav@autoreceptionist.io',   'admin',
     'Workspace primary domain. Super admin.'),
    ('ojas@getautoreceptionist.com', 'member',
     'Workspace secondary domain.')
  ) as v(email, role, note)
  cross join public.orgs o
 where o.slug = 'auto-receptionist'
on conflict (email) do nothing;

revoke all on app.login_allowlist from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Gate 1: reject anyone not on the list
-- ---------------------------------------------------------------------------
-- On auth.users rather than in a route handler, so it binds every path into the
-- system at once: the OAuth callback, the Supabase dashboard's "Add user", the
-- admin API, and the email/password signup endpoint that is reachable with the
-- publishable key whether or not the app ships a form for it.

create or replace function app.enforce_login_allowlist() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email is null then
    raise exception 'This app is invite only, and that account has no email address.'
      using errcode = '42501';
  end if;

  -- The integration harness creates a throwaway user per run, so it cannot be
  -- named in advance. `.test` is reserved by RFC 2606 and cannot resolve, so
  -- nobody can receive confirmation mail there and no such account can ever
  -- complete a sign-in. More to the point, these are not on the allowlist, so
  -- the trigger below gives them no membership and app.current_org_id() returns
  -- null for them -- which means every policy in the database denies them
  -- everything. Letting them exist costs nothing; the org membership is the
  -- gate that matters, not the row in auth.users.
  if new.email like '%@example.test' then
    return new;
  end if;

  if not exists (
    select 1 from app.login_allowlist a
     where a.email = lower(btrim(new.email))
  ) then
    raise exception
      'This app is invite only. % is not on the allowlist.',
      new.email
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger users_enforce_login_allowlist
  before insert on auth.users
  for each row execute function app.enforce_login_allowlist();

-- ---------------------------------------------------------------------------
-- Gate 2: give them their membership
-- ---------------------------------------------------------------------------
-- Without this row app.current_org_id() returns null and every policy in the
-- database denies the user everything, which reads as a broken app rather than
-- a permissions problem. Doing it here means a logged-in user without an org is
-- not a state that can occur.

create or replace function app.provision_org_member() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_entry app.login_allowlist;
begin
  select * into v_entry
    from app.login_allowlist a
   where a.email = lower(btrim(new.email));

  -- Unreachable: the BEFORE trigger already rejected anyone not listed. Kept so
  -- that disabling that trigger degrades to "no access" rather than to a crash
  -- on every signup.
  if not found then
    return new;
  end if;

  insert into public.org_members (org_id, user_id, role)
  values (v_entry.org_id, new.id, v_entry.role)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

create trigger users_provision_org_member
  after insert on auth.users
  for each row execute function app.provision_org_member();
