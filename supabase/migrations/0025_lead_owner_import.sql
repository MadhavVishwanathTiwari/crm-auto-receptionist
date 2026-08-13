-- Carrying ownership across from the Google Sheet.
--
-- The sheet's `lead_owner` column holds the address of whichever operator was
-- working that lead. The importer dropped it: `detectShape` reads `leadowner`
-- as the marker of a legacy sheet, but there was no canonical field to map it
-- onto, so 167 already-worked leads landed unclaimed and the only way back was
-- to reassign them by hand, one at a time.
--
-- Ownership cannot simply be a column in the insert. `claimed_by` is guarded by
-- `leads_guard_protected_columns`, deliberately, and status is derived from the
-- event log rather than typed. So this is the bulk sibling of claim_lead():
-- it moves the same three columns under the same bypass and writes the same
-- `claimed` event, with the difference that the actor is the operator named in
-- the sheet rather than whoever is holding the mouse.
--
-- Two functions rather than one, because there are two populations:
--   * assign_lead_owners()  -- the importer, for rows it has just inserted
--   * backfill_lead_owners() -- leads already imported, read back out of
--                               `leads.raw`, which is where commitImport keeps
--                               the original CSV row verbatim
-- Both run every assignment through app.assign_lead_owner_one(), so the rules
-- about who may be handed what are written once.

-- ---------------------------------------------------------------------------
-- Which addresses are the same human
-- ---------------------------------------------------------------------------
-- 0009 added madhav@tryautoreceptionist.com as a second login identity and
-- recorded the consequence in a comment: the app identifies an operator by auth
-- user, so those two addresses are two operators, and nothing errors when they
-- diverge -- it just looks wrong.
--
-- A sheet written over months of work is exactly where that bites. The rows say
-- `madhav@tryautoreceptionist.com`; whether an auth user exists under that
-- address or under madhav@autoreceptionist.io depends on which account he
-- happened to sign in with, and neither answer is knowable from the CSV.
--
-- So the alias group is data, in a migration file, next to the allowlist that
-- created the ambiguity. Resolution looks for org members whose address is in
-- the same group. Exactly one match is the answer; two is a genuine ambiguity
-- and raises rather than picking, because guessing wrong here silently gives a
-- lead to the wrong person and there is no error anywhere to notice it by.

create table app.operator_aliases (
  email      text primary key,
  operator   text not null,
  note       text,
  created_at timestamptz not null default now(),

  constraint operator_aliases_email_normalized
    check (email = lower(btrim(email)))
);

comment on table app.operator_aliases is
  'Addresses that denote the same human. Keyed the same way as '
  'app.login_allowlist, and in the app schema for the same reason: PostgREST '
  'does not expose it, so there is no API path and no RLS policy to get wrong.';

insert into app.operator_aliases (email, operator, note) values
  ('madhav@autoreceptionist.io',     'madhav',
   'Workspace primary domain. Same human as the try address (see 0009).'),
  ('madhav@tryautoreceptionist.com', 'madhav',
   'What the outreach sheet writes in lead_owner.'),
  ('ojas@getautoreceptionist.com',   'ojas',
   'One address, one identity. Listed so the group lookup is uniform.')
on conflict (email) do nothing;

revoke all on app.operator_aliases from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Email -> auth user, scoped to the caller's org
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because auth.users is not readable by `authenticated`, and
-- constrained to members of the org passed in so that it cannot be used to ask
-- whether an arbitrary address has an account here. It can only ever tell you
-- about the people you already share an org with.

create or replace function app.resolve_operator(p_org uuid, p_email text)
returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_norm  text;
  v_group text;
  v_ids   uuid[];
begin
  if p_org is null or p_email is null or btrim(p_email) = '' then
    return null;
  end if;

  v_norm := lower(btrim(p_email));

  -- An address nobody has aliased is its own group, so an operator who is not
  -- in the table resolves by plain address rather than not at all.
  select a.operator into v_group
    from app.operator_aliases a
   where a.email = v_norm;
  v_group := coalesce(v_group, v_norm);

  select array_agg(m.user_id)
    into v_ids
    from public.org_members m
    join auth.users u on u.id = m.user_id
   where m.org_id = p_org
     and coalesce(
           (select a.operator
              from app.operator_aliases a
             where a.email = lower(btrim(u.email))),
           lower(btrim(u.email))
         ) = v_group;

  if v_ids is null then
    return null;
  end if;

  if array_length(v_ids, 1) > 1 then
    raise exception
      '% matches % accounts in this org. Consolidate the logins, or narrow '
      'app.operator_aliases, before assigning ownership in bulk.',
      v_norm, array_length(v_ids, 1)
      using errcode = '22023';
  end if;

  return v_ids[1];
end;
$$;

revoke all on function app.resolve_operator(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- One assignment
-- ---------------------------------------------------------------------------
-- Returns an outcome string rather than raising, because a bulk migration wants
-- a report at the end and not a stop at the first surprise. The one thing it
-- does raise on is a permission problem, which is not a per-row fact.
--
-- p_dry_run stops before the write and returns what would have happened, so the
-- operator sees the tally before 300 leads change hands.

create or replace function app.assign_lead_owner_one(
  p_org         uuid,
  p_lead_id     uuid,
  p_owner_email text,
  p_dry_run     boolean
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_owner   uuid;
  v_current uuid;
begin
  if p_owner_email is null or btrim(p_owner_email) = '' then
    return 'no_owner';
  end if;

  v_owner := app.resolve_operator(p_org, p_owner_email);
  if v_owner is null then
    return 'unknown_owner';
  end if;

  -- Handing a lead to somebody else is what reassign_lead() treats as an admin
  -- action, and this is the bulk version of exactly that. Assigning to yourself
  -- needs no privilege, so an ordinary member can still import their own sheet.
  if v_owner <> auth.uid() and not app.is_admin() then
    raise exception
      'only an admin may assign a lead to another operator (%)', lower(btrim(p_owner_email))
      using errcode = '42501';
  end if;

  select l.claimed_by into v_current
    from public.leads l
   where l.id = p_lead_id
     and l.org_id = p_org
     and l.archived_at is null;

  if not found then
    return 'not_found';
  end if;
  if v_current = v_owner then
    return 'already_owned';
  end if;
  -- Never takes a lead off somebody. A sheet is a snapshot of what was true
  -- when it was exported; the database is what is true now, and a migration
  -- that silently overrode live ownership would be the worst of both.
  if v_current is not null then
    return 'claimed_by_other';
  end if;

  if p_dry_run then
    return 'assigned';
  end if;

  perform set_config('app.bypass_lead_guard', 'on', true);

  -- `claimed_by is null` is repeated in the WHERE rather than trusted from the
  -- SELECT above: same reasoning as claim_lead(), a read-then-write is a race
  -- and under READ COMMITTED this re-check is what settles it.
  update public.leads l
     set claimed_by  = v_owner,
         claimed_at  = now(),
         released_at = null,
         claim_count = l.claim_count + 1
   where l.id = p_lead_id
     and l.org_id = p_org
     and l.claimed_by is null;

  if not found then
    return 'claimed_by_other';
  end if;

  -- The event carries the operator as its actor, not the caller. That is the
  -- whole point: `claimed` ranks above `imported` in app.lead_status_from_events
  -- so the trigger moves the lead to `claimed`, and the timeline reads as the
  -- person who actually owns it rather than as whoever ran the migration.
  insert into public.lead_events (org_id, lead_id, type, actor_id, payload)
  values (p_org, p_lead_id, 'claimed', v_owner,
          jsonb_build_object(
            'source', 'sheet_import',
            'owner_email', lower(btrim(p_owner_email)),
            'assigned_by', auth.uid()
          ));

  return 'assigned';
end;
$$;

revoke all on function app.assign_lead_owner_one(uuid, uuid, text, boolean)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- What the importer calls
-- ---------------------------------------------------------------------------

create or replace function public.assign_lead_owners(
  p_assignments jsonb,
  p_dry_run     boolean default false
) returns table (lead_id uuid, owner_email text, outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org  uuid := app.current_org_id();
  v_item jsonb;
begin
  if v_org is null then
    raise exception 'not a member of any org' using errcode = '42501';
  end if;
  if p_assignments is null or jsonb_typeof(p_assignments) <> 'array' then
    raise exception 'p_assignments must be a JSON array' using errcode = '22023';
  end if;
  -- The importer chunks; this bound is what stops a hand-rolled call holding a
  -- transaction open across an unbounded loop.
  if jsonb_array_length(p_assignments) > 2000 then
    raise exception 'at most 2000 assignments per call' using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_assignments)
  loop
    lead_id     := nullif(v_item->>'lead_id', '')::uuid;
    owner_email := v_item->>'owner_email';
    outcome     := app.assign_lead_owner_one(v_org, lead_id, owner_email, p_dry_run);
    return next;
  end loop;
end;
$$;

comment on function public.assign_lead_owners(jsonb, boolean) is
  'Bulk claim on behalf of the operator named in each assignment. Outcomes per '
  'lead: assigned, already_owned, claimed_by_other, unknown_owner, no_owner, '
  'not_found.';

-- ---------------------------------------------------------------------------
-- Fixing what is already in the table
-- ---------------------------------------------------------------------------
-- commitImport stores the original CSV row on the lead as `raw`, so the sheet's
-- lead_owner is already in the database for every lead that came from it. That
-- is what makes this recoverable without a re-import -- and a re-import would
-- not work anyway, since every row would now be skipped as a duplicate and
-- skipped rows produce no assignments.

create or replace function public.backfill_lead_owners(
  p_raw_key text default 'lead_owner',
  p_dry_run boolean default true
) returns table (lead_id uuid, company text, owner_email text, outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_row record;
begin
  if v_org is null then
    raise exception 'not a member of any org' using errcode = '42501';
  end if;
  if p_raw_key is null or btrim(p_raw_key) = '' then
    raise exception 'p_raw_key is required' using errcode = '22023';
  end if;

  for v_row in
    select l.id           as id,
           l.company_name as name,
           btrim(l.raw->>p_raw_key) as owner
      from public.leads l
     where l.org_id = v_org
       and l.archived_at is null
       and l.claimed_by is null
       and jsonb_exists(l.raw, p_raw_key)
       and btrim(coalesce(l.raw->>p_raw_key, '')) <> ''
     order by l.created_at
  loop
    lead_id     := v_row.id;
    company     := v_row.name;
    owner_email := v_row.owner;
    outcome     := app.assign_lead_owner_one(v_org, v_row.id, v_row.owner, p_dry_run);
    return next;
  end loop;
end;
$$;

comment on function public.backfill_lead_owners(text, boolean) is
  'One-time migration helper: re-reads lead_owner out of leads.raw and claims '
  'each lead for the operator named there. Defaults to a dry run.';

revoke all on function public.assign_lead_owners(jsonb, boolean) from public, anon;
revoke all on function public.backfill_lead_owners(text, boolean) from public, anon;

grant execute on function public.assign_lead_owners(jsonb, boolean) to authenticated;
grant execute on function public.backfill_lead_owners(text, boolean) to authenticated;
