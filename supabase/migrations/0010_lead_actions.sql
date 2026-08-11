-- Three unrelated-looking changes, each unblocking one of the Phase 1 surfaces
-- the schema was designed for but nothing ever built: manual timezone
-- assignment, a live grid, and audit screenshots.

-- ---------------------------------------------------------------------------
-- 1. Clearing a timezone has never been possible
-- ---------------------------------------------------------------------------
-- 0004 set timezone_source := 'manual' on ANY change to timezone. Setting a
-- zone works. Clearing a wrong one to null sets the source to 'manual' while
-- the zone is null, which violates leads_timezone_source:
--
--   check ((timezone is null) = (timezone_source is null))
--
-- so un-assigning always errored. Nothing hit it because only the cron wrote
-- the column, and the cron only ever fills it in. A human correcting a bad
-- zone is the first caller that needs to take one away.
--
-- The rest of the function is unchanged; it is repeated in full because
-- create or replace has no way to patch a single branch.

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

-- ---------------------------------------------------------------------------
-- 2. Realtime on leads
-- ---------------------------------------------------------------------------
-- Realtime broadcasts TABLES, not views, which is why leads.status is a real
-- column maintained by a trigger rather than something derived at read time.
-- This is the other half of that decision.
--
-- REPLICA IDENTITY is deliberately left at its default (primary key). FULL is
-- only needed to receive old_record, or to let Realtime evaluate RLS on a
-- DELETE — and leads are never deleted. There is no DELETE policy at all; they
-- are archived via archived_at. FULL would write the entire previous row,
-- including the `search` tsvector, into WAL on every single update.

do $$
begin
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    create publication supabase_realtime;
  end if;
end;
$$;

alter publication supabase_realtime add table public.leads;

-- ---------------------------------------------------------------------------
-- 3. The evidence bucket
-- ---------------------------------------------------------------------------
-- Private. Layout is lead-evidence/{org_id}/{lead_id}/{uuid}.{ext}, so the
-- first path segment is the tenant boundary and every policy below is an
-- equality test against it.

insert into storage.buckets (id, name, public)
values ('lead-evidence', 'lead-evidence', false)
on conflict (id) do nothing;

-- storage.objects already has RLS enabled by Supabase; these are additive.

create policy lead_evidence_objects_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'lead-evidence'
    and (storage.foldername(name))[1] = app.current_org_id()::text
  );

create policy lead_evidence_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'lead-evidence'
    and (storage.foldername(name))[1] = app.current_org_id()::text
  );

-- No UPDATE policy: an audit artifact is written once. Replacing one means
-- uploading a new object and pointing the evidence row at it, which leaves the
-- original in place for the audit trail.

-- Deleting evidence is the dangerous direction, same reasoning as removing a
-- suppression, so it is admin-only.
create policy lead_evidence_objects_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'lead-evidence'
    and (storage.foldername(name))[1] = app.current_org_id()::text
    and app.is_admin()
  );
