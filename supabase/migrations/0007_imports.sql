-- CSV import: the run, its per-row outcomes, and the near-duplicate queue.
--
-- Every row of an upload lands in exactly one of four outcomes, which is what
-- makes the import report add up: inserted, skipped_duplicate, flagged_review,
-- failed_validation.

create table imports (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,

  filename         text not null,
  shape            text not null default 'custom',  -- clay | legacy_sheet | custom
  header_row_index smallint not null default 0,
  detected_headers jsonb not null default '[]'::jsonb,
  column_mapping   jsonb not null default '{}'::jsonb,

  status     import_status not null default 'uploaded',
  total_rows integer not null default 0,

  counts jsonb not null default
    '{"inserted":0,"skipped_duplicate":0,"flagged_review":0,"failed_validation":0}'::jsonb,

  error        text,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

create index imports_org_created_idx on imports (org_id, created_at desc);

-- Now that imports exists, close the loop from leads.
alter table leads
  add constraint leads_import_id_fkey
  foreign key (import_id) references imports(id) on delete set null;

-- One row per CSV line. This IS the import report — there is deliberately no
-- separate errors table, because splitting failures out turns every "what went
-- wrong" query into a union and separates the error from the payload that
-- caused it.
create table import_rows (
  id        uuid primary key default gen_random_uuid(),
  import_id uuid not null references imports(id) on delete cascade,
  org_id    uuid not null references orgs(id) on delete cascade,
  row_index integer not null,

  raw jsonb not null,
  -- Canonical fields whose raw value was Clay junk and became null, so the
  -- report can show what was discarded rather than silently dropping it.
  cleaned_fields text[] not null default '{}',

  outcome         import_row_outcome not null default 'pending',
  lead_id         uuid references leads(id) on delete set null,
  matched_lead_id uuid references leads(id) on delete set null,
  match_kind      dedupe_match_kind,
  error_detail    text,

  created_at timestamptz not null default now(),
  unique (import_id, row_index)
);

create index import_rows_outcome_idx on import_rows (import_id, outcome);

-- Near-duplicates: same place_id, website domain or phone, but a different
-- work_email. Surfaced rather than dropped, because two contacts at one company
-- are usually both worth having and only a human can tell.
create table dedupe_reviews (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  import_id     uuid references imports(id) on delete cascade,
  import_row_id uuid references import_rows(id) on delete cascade,

  existing_lead_id uuid not null references leads(id) on delete cascade,
  match_kind       dedupe_match_kind not null,
  match_value      text not null,

  -- The candidate is kept here in full, so a decision can still be actioned
  -- after the import that produced it is deleted.
  incoming jsonb not null,

  decision        review_decision not null default 'pending',
  decided_by      uuid references auth.users(id) on delete set null,
  decided_at      timestamptz,
  created_lead_id uuid references leads(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index dedupe_reviews_pending_idx on dedupe_reviews (org_id, created_at desc)
  where decision = 'pending';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table imports        enable row level security;
alter table import_rows    enable row level security;
alter table dedupe_reviews enable row level security;

create policy imports_select on imports
  for select to authenticated
  using (org_id = app.current_org_id());

create policy imports_insert on imports
  for insert to authenticated
  with check (org_id = app.current_org_id() and created_by = auth.uid());

create policy imports_update on imports
  for update to authenticated
  using (org_id = app.current_org_id())
  with check (org_id = app.current_org_id());

create policy import_rows_select on import_rows
  for select to authenticated
  using (org_id = app.current_org_id());

create policy import_rows_insert on import_rows
  for insert to authenticated
  with check (org_id = app.current_org_id());

create policy import_rows_update on import_rows
  for update to authenticated
  using (org_id = app.current_org_id())
  with check (org_id = app.current_org_id());

create policy dedupe_reviews_select on dedupe_reviews
  for select to authenticated
  using (org_id = app.current_org_id());

create policy dedupe_reviews_insert on dedupe_reviews
  for insert to authenticated
  with check (org_id = app.current_org_id());

create policy dedupe_reviews_update on dedupe_reviews
  for update to authenticated
  using (org_id = app.current_org_id())
  with check (org_id = app.current_org_id());
