-- Exact address beats the alias group.
--
-- 0025 resolved an operator by alias group only, so that a sheet naming
-- madhav@tryautoreceptionist.com would still find him if he had signed in as
-- madhav@autoreceptionist.io. Against the real project that turns out to be
-- ambiguous rather than helpful: BOTH accounts exist, both are members of the
-- org, and both are in group 'madhav'. Every assignment raised.
--
-- Raising was the right default -- picking one at random hands 30 leads to a
-- coin toss and nothing anywhere reports it -- but there is a tiebreak here
-- that is not a guess. The sheet names an address. If an account exists at
-- exactly that address, that is the strongest evidence available and no group
-- membership can outrank it.
--
-- So: exact match first, alias group only as the fallback for the case it was
-- written for (the sheet names an address nobody signs in with). The ambiguity
-- exception stays, and now only fires when the fallback itself is ambiguous,
-- which is a genuine "two accounts, no way to tell" and still worth stopping on.

create or replace function app.resolve_operator(p_org uuid, p_email text)
returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_norm  text;
  v_group text;
  v_id    uuid;
  v_ids   uuid[];
begin
  if p_org is null or p_email is null or btrim(p_email) = '' then
    return null;
  end if;

  v_norm := lower(btrim(p_email));

  -- 1. The address itself, among members of this org.
  select m.user_id
    into v_id
    from public.org_members m
    join auth.users u on u.id = m.user_id
   where m.org_id = p_org
     and lower(btrim(u.email)) = v_norm;

  if v_id is not null then
    return v_id;
  end if;

  -- 2. Failing that, another address belonging to the same human.
  select a.operator into v_group
    from app.operator_aliases a
   where a.email = v_norm;

  -- An address nobody has aliased is its own group. Step 1 already covered
  -- that case, so there is nothing left to find.
  if v_group is null then
    return null;
  end if;

  select array_agg(m.user_id)
    into v_ids
    from public.org_members m
    join auth.users u on u.id = m.user_id
   where m.org_id = p_org
     and exists (
       select 1 from app.operator_aliases a
        where a.email = lower(btrim(u.email))
          and a.operator = v_group
     );

  if v_ids is null then
    return null;
  end if;

  if array_length(v_ids, 1) > 1 then
    raise exception
      '% has no account here, and % accounts share its operator group. '
      'Sign in once as %, or narrow app.operator_aliases, before assigning '
      'ownership in bulk.',
      v_norm, array_length(v_ids, 1), v_norm
      using errcode = '22023';
  end if;

  return v_ids[1];
end;
$$;

revoke all on function app.resolve_operator(uuid, text) from public, anon, authenticated;
