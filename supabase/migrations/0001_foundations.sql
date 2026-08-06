-- Foundations: the `app` schema, the domain vocabulary (enums), and the
-- normalizer functions that every dedupe key is built from.
--
-- Nothing here depends on anything else, and everything else depends on this.

-- ---------------------------------------------------------------------------
-- The `app` schema
-- ---------------------------------------------------------------------------
-- PostgREST exposes only `public`. Helper functions live in `app` so they can
-- never be invoked over /rpc by a browser, even by accident. Only functions we
-- deliberately place in `public` are callable by clients.

create schema if not exists app;
grant usage on schema app to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type org_role as enum ('admin', 'member');

-- Derived from lead_events by app.lead_status_from_events(). Never typed by a
-- user; see the guard trigger in 0003.
create type lead_status as enum (
  'imported', 'qualified', 'claimed', 'audited', 'queued',
  'sent', 'delivered', 'opened', 'replied', 'bounced', 'unsubscribed',
  'closed_won', 'closed_lost', 'do_not_contact'
);

-- The three outcomes a human may assert directly. Written as a `closed` event
-- with a payload, so even these pass through the append-only log.
create type terminal_outcome as enum ('closed_won', 'closed_lost', 'do_not_contact');

create type lead_event_type as enum (
  'imported', 'qualified', 'disqualified',
  'claimed', 'released', 'reassigned',
  'audited', 'queued',
  'sent', 'delivered', 'opened', 'replied', 'bounced', 'unsubscribed',
  'demo_ready', 'closed',
  'note', 'manual_override'
);

-- The two outreach angles. Determines which evidence fields matter and which
-- template variables are available.
create type angle_type as enum ('soft_text_audit', 'voicemail_drop_audit');

create type email_confidence as enum ('high', 'medium', 'low', 'unknown');

create type verification_status as enum (
  'verified', 'unverified', 'catch_all', 'invalid', 'unknown'
);

-- How a lead's IANA zone was determined. NULL zone means "unknown", and an
-- unknown zone is never scheduled — we do not guess.
create type timezone_source as enum ('coordinates', 'manual', 'import');

create type import_status as enum (
  'uploaded', 'mapping', 'validating', 'ready', 'committing', 'completed', 'failed'
);

-- The four outcomes the import report counts. Every row lands in exactly one.
create type import_row_outcome as enum (
  'pending', 'inserted', 'skipped_duplicate', 'flagged_review', 'failed_validation'
);

-- work_email collides hard (dropped). The other three are near-duplicates and
-- go to a review queue rather than being dropped silently.
create type dedupe_match_kind as enum (
  'work_email', 'place_id', 'website_domain', 'phone'
);

create type review_decision as enum (
  'pending', 'merged', 'inserted_anyway', 'discarded'
);

create type scheduled_send_status as enum (
  'planned', 'blocked', 'claimed', 'sending', 'sent', 'failed', 'cancelled', 'skipped'
);

-- First touches prefer Tue/Wed/Thu; follow-ups carry Mon/Fri and overflow.
-- Expressed as per-weekday weights in config, never as hardcoded logic.
create type touch_kind as enum ('first', 'followup');

create type mailbox_provider as enum ('gmail');

create type mailbox_health_kind as enum (
  'auth_error', 'quota_error', 'bounce_spike', 'spam_complaint',
  'reply_rate_collapse', 'send_failure', 'ramp_advanced', 'paused', 'resumed'
);

create type suppression_reason as enum (
  'unsubscribed', 'bounced_hard', 'complaint', 'manual_dnc', 'competitor', 'customer'
);

create type alert_kind as enum (
  'reply', 'bounce', 'unsubscribe', 'mailbox_auth', 'cap_exhausted',
  'import_failed', 'orphan_demo', 'timezone_unresolved', 'dedupe_review',
  'demo_missing', 'pre_send_review', 'new_pool_leads'
);

create type message_direction as enum ('outbound', 'inbound');

-- ---------------------------------------------------------------------------
-- Normalizers
-- ---------------------------------------------------------------------------
-- These MUST be IMMUTABLE: they back generated columns on `leads`, and Postgres
-- only permits immutable expressions there. That constraint is also why phone
-- normalization is hand-written SQL rather than libphonenumber-js — a JS
-- library cannot participate in a generated column, and the ICP is US/CA only.
--
-- lib/normalize/*.ts mirrors these for import-time grouping and UI preview.
-- tests/unit/normalize-parity.test.ts runs the same vectors through both and
-- asserts they agree, which is the only way to keep two implementations honest.

-- Providers known to treat "+tag" as an alias of the base address. Stripping it
-- anywhere else would be a guess, and over-merging is worse than under-merging:
-- a false duplicate silently discards a real lead, whereas a missed one merely
-- shows up in the review queue.
create or replace function app.plus_addressing_providers() returns text[]
language sql immutable parallel safe as $$
  select array[
    'gmail.com', 'googlemail.com',
    'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
    'yahoo.com', 'ymail.com',
    'fastmail.com', 'proton.me', 'protonmail.com', 'icloud.com'
  ]::text[];
$$;

create or replace function app.normalize_email(p text) returns text
language sql immutable parallel safe as $$
  with parsed as (
    select
      split_part(lower(btrim(coalesce(p, ''))), '@', 1) as local_part,
      split_part(lower(btrim(coalesce(p, ''))), '@', 2) as domain_part
  ),
  stripped as (
    select
      case when domain_part = any (app.plus_addressing_providers())
           then split_part(local_part, '+', 1)
           else local_part
      end as local_part,
      domain_part
    from parsed
  )
  select case
    when local_part = '' or domain_part = '' then null
    -- Gmail additionally ignores dots in the local part, and googlemail.com is
    -- the same mailbox as gmail.com.
    when domain_part in ('gmail.com', 'googlemail.com')
      then replace(local_part, '.', '') || '@gmail.com'
    else local_part || '@' || domain_part
  end
  from stripped;
$$;

comment on function app.normalize_email(text) is
  'Canonical email for org-wide dedupe. Lowercases, strips +tags for providers '
  'known to support them, and dot-folds Gmail. Returns NULL for anything that '
  'is not shaped like an address.';

create or replace function app.normalize_domain(p text) returns text
language sql immutable parallel safe as $$
  select nullif(
    regexp_replace(                                    -- 5. trailing FQDN root dot
      regexp_replace(                                  -- 4. leading www.
        regexp_replace(                                -- 3. :port
          regexp_replace(                              -- 2. /path, ?query, #fragment
            regexp_replace(                            -- 1. scheme:// and user@
              lower(btrim(coalesce(p, ''))),
              '^[a-z][a-z0-9+.-]*://(?:[^@/]*@)?', ''),
            '[/?#].*$', ''),
          ':[0-9]+$', ''),
        '^www\.', ''),
      '\.$', ''),
    '');
$$;

comment on function app.normalize_domain(text) is
  'Bare registrable hostname. Deliberately matches domainKey() in the '
  'Auto-Receptionist repo (scripts/lib/sheet-rows.mjs), because normalized '
  'domain is the primary join key for demo ingest — that repo has no place_id.';

create or replace function app.normalize_phone(p text) returns text
language sql immutable parallel safe as $$
  with digits as (
    select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as n
  )
  select case
    -- NANP area codes and exchange codes never begin with 0 or 1, so this also
    -- rejects junk that happens to have ten digits.
    when length(n) = 10 and substring(n, 1, 1) between '2' and '9'
      then '+1' || n
    when length(n) = 11 and left(n, 1) = '1' and substring(n, 2, 1) between '2' and '9'
      then '+' || n
    else null
  end
  from digits;
$$;

comment on function app.normalize_phone(text) is
  'E.164 for US/CA (NANP) only. Returns NULL rather than guessing for anything '
  'else, so a bad value can never become a false duplicate.';

-- ---------------------------------------------------------------------------
-- Shared triggers
-- ---------------------------------------------------------------------------

create or replace function app.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
