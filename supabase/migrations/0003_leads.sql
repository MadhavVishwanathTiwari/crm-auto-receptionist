-- The canonical lead record, the append-only event log it derives from, the
-- evidence artifacts that feed the outreach copy, and the do-not-contact list.
--
-- Status derivation, the write guards, RLS, and claiming all live in 0004/0005.

-- ---------------------------------------------------------------------------
-- leads
-- ---------------------------------------------------------------------------

create table leads (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,

  -- FK added in the imports migration; declared here so the column exists for
  -- the importer without forcing table creation order.
  import_id      uuid,
  source         text not null default 'csv',   -- csv_clay | csv_legacy | manual | api

  -- --- identity ------------------------------------------------------------
  place_id       text,
  company_name   text,
  first_name     text,
  middle_name    text,
  last_name      text,
  name_suffix    text,
  title          text,

  -- --- email ---------------------------------------------------------------
  -- work_email is THE send target. Everything below it is imported for
  -- reference and must never be used as a destination; nothing in the
  -- scheduler or the Gmail layer reads those columns.
  work_email     text,
  work_email_norm text generated always as (app.normalize_email(work_email)) stored,
  email_1        text,
  email_2        text,
  email_3        text,
  likely_email   text,
  email_confidence email_confidence not null default 'unknown',
  email_provider text,
  verification   verification_status not null default 'unknown',

  -- --- contact and location ------------------------------------------------
  phone          text,
  phone_e164     text generated always as (app.normalize_phone(phone)) stored,
  website        text,
  website_domain text generated always as (app.normalize_domain(website)) stored,
  gmaps_url      text,
  city           text,
  state          text,
  postal_code    text,
  country_code   text default 'US',
  latitude       numeric(9, 6),
  longitude      numeric(9, 6),

  -- IANA zone. NULL means unknown, and an unknown zone is NEVER scheduled —
  -- see the planner. We do not fall back to a state lookup, which silently
  -- corrupts the multi-zone states (FL, TX, TN, ID, OR, KS, NE, ND, SD, MI,
  -- IN, KY) and Arizona's no-DST behaviour.
  timezone       text,
  timezone_source timezone_source,
  needs_timezone boolean generated always as (timezone is null) stored,

  -- --- firmographics -------------------------------------------------------
  industry       text,
  rating         numeric(2, 1),
  reviews_count  integer,
  employee_count integer,

  -- The qualification gate from the brief: rating >= 3.5 and a send target.
  -- Hardcoded rather than read from org_settings because a generated column
  -- cannot reference another table, and one source of truth beats a config
  -- knob that silently disagrees with the column.
  is_qualified   boolean generated always as (
                   rating is not null and rating >= 3.5
                   and work_email is not null and btrim(work_email) <> ''
                 ) stored,

  -- --- socials -------------------------------------------------------------
  company_linkedin  text,
  company_instagram text,
  company_facebook  text,
  company_twitter   text,
  personal_linkedin  text,
  personal_instagram text,
  personal_facebook  text,
  personal_twitter   text,

  -- --- outreach metadata ---------------------------------------------------
  lead_score     integer,
  angle_type     angle_type,
  notes          text,

  -- --- ownership -----------------------------------------------------------
  -- Written only by the claim RPCs in 0005; the guard trigger in 0004 rejects
  -- direct writes so claiming can never become read-then-write.
  claimed_by     uuid references auth.users(id) on delete set null,
  claimed_at     timestamptz,
  released_at    timestamptz,
  claim_count    integer not null default 0,

  -- --- derived state -------------------------------------------------------
  -- A real column, not a view, because Supabase Realtime broadcasts table
  -- changes and produces nothing for views — the grid would never be pushed a
  -- status change. Maintained by the trigger in 0004.
  status            lead_status not null default 'imported',
  status_updated_at timestamptz not null default now(),
  terminal_outcome  terminal_outcome,
  halted_at         timestamptz,
  halt_reason       text,

  -- --- sequence ------------------------------------------------------------
  sequence_id         uuid,
  sequence_started_at timestamptz,
  sequence_paused_at  timestamptz,

  -- --- demo ----------------------------------------------------------------
  -- demo_web_url stays nullable and unpopulated: the Auto-Receptionist repo
  -- emits exactly one URL, https://autoreceptionist.io/sandbox/<slug>, stored
  -- in a column it calls demo_txt. That name refers to the outreach channel,
  -- not a text-vs-web variant — the page carries both chat and voice.
  demo_slug     text,
  demo_txt_url  text,
  demo_web_url  text,
  demo_ready_at timestamptz,

  -- The original CSV row, for audit and for re-deriving a field we mapped wrong.
  raw jsonb not null default '{}'::jsonb,

  search tsvector generated always as (
    to_tsvector('simple',
      coalesce(company_name, '') || ' ' ||
      coalesce(first_name, '')   || ' ' ||
      coalesce(last_name, '')    || ' ' ||
      coalesce(work_email, '')   || ' ' ||
      coalesce(city, '')         || ' ' ||
      coalesce(state, ''))
  ) stored,

  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint leads_rating_range
    check (rating is null or (rating >= 0 and rating <= 5)),
  -- A zone and how we got it travel together, so an unresolved lead can never
  -- look resolved.
  constraint leads_timezone_source
    check ((timezone is null) = (timezone_source is null))
);

-- The org-wide dedupe guarantee. NULLs are distinct in Postgres, so leads with
-- no work_email are never collapsed into each other.
--
-- Deliberately NOT partial: a partial unique index is not a valid ON CONFLICT
-- arbiter from supabase-js, which is the trap ar-lead-finder hit in its
-- migration 0013.
create unique index leads_org_work_email_key
  on leads (org_id, work_email_norm);

-- place_id, website_domain and phone_e164 are indexed but NOT unique. A
-- collision on any of them is a NEAR-duplicate that belongs in the review
-- queue, and a hard constraint would drop a real lead instead of surfacing it.
create index leads_place_id_idx on leads (org_id, place_id)
  where place_id is not null;
create index leads_domain_idx on leads (org_id, website_domain)
  where website_domain is not null;
create index leads_phone_idx on leads (org_id, phone_e164)
  where phone_e164 is not null;

create index leads_org_status_idx  on leads (org_id, status);
create index leads_org_claimed_idx on leads (org_id, claimed_by);
create index leads_org_created_idx on leads (org_id, created_at desc);
create index leads_needs_tz_idx    on leads (org_id) where timezone is null;
create index leads_unclaimed_idx   on leads (org_id, created_at desc)
  where claimed_by is null and archived_at is null;
create index leads_search_idx on leads using gin (search);

create trigger leads_set_updated_at before update on leads
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- lead_events — append-only, and the source of truth for status
-- ---------------------------------------------------------------------------

create table lead_events (
  id       uuid primary key default gen_random_uuid(),
  org_id   uuid not null references orgs(id) on delete cascade,
  lead_id  uuid not null references leads(id) on delete cascade,
  type     lead_event_type not null,

  -- NULL actor means the system did it (scheduler, webhook, cron).
  actor_id uuid references auth.users(id) on delete set null,

  occurred_at timestamptz not null default now(),
  payload     jsonb not null default '{}'::jsonb,

  sequence_step_id  uuid,
  scheduled_send_id uuid,

  -- Provider-supplied idempotency key: a Gmail history id, message id, or
  -- webhook delivery id. Lets a redelivered bounce or reply notification be
  -- inserted twice without producing two events. NULLs are distinct, so
  -- human-authored events (notes, audits) always insert.
  dedupe_token text,

  created_at timestamptz not null default now(),

  unique (lead_id, type, dedupe_token)
);

create index lead_events_lead_idx on lead_events (lead_id, occurred_at desc);
create index lead_events_org_type_idx on lead_events (org_id, type, occurred_at desc);

-- ---------------------------------------------------------------------------
-- lead_evidence — the audit artifacts the first touch quotes back
-- ---------------------------------------------------------------------------

create table lead_evidence (
  id      uuid primary key default gen_random_uuid(),
  org_id  uuid not null references orgs(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,

  angle_type angle_type not null,

  -- All three are stored on purpose. The copy quotes the LOCAL time back to the
  -- prospect ("I texted your business at 3am"), so that wall-clock reading must
  -- be frozen at capture rather than recomputed later from leads.timezone,
  -- which an operator may correct after the fact.
  audited_at       timestamptz not null,
  audited_at_local timestamp   not null,
  audit_timezone   text        not null,

  response_delay_seconds integer,
  outcome text,   -- free text: 'no response', 'auto-reply: closed', 'voicemail'

  -- Private bucket, path lead-evidence/{org_id}/{lead_id}/{uuid}.png
  screenshot_path text,
  notes text,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint lead_evidence_delay_nonneg
    check (response_delay_seconds is null or response_delay_seconds >= 0)
);

create index lead_evidence_lead_idx on lead_evidence (lead_id, created_at desc);

-- ---------------------------------------------------------------------------
-- suppressions — checked before every send
-- ---------------------------------------------------------------------------

create table suppressions (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,

  -- Any one of these may be set. Domain-level suppression exists so a single
  -- "remove us" reply can cover every contact at that company.
  email_norm text,
  domain     text,
  phone_e164 text,

  reason     suppression_reason not null,
  lead_id    uuid references leads(id) on delete set null,
  notes      text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint suppressions_has_target
    check (email_norm is not null or domain is not null or phone_e164 is not null)
);

create unique index suppressions_email_key  on suppressions (org_id, email_norm)
  where email_norm is not null;
create unique index suppressions_domain_key on suppressions (org_id, domain)
  where domain is not null;
