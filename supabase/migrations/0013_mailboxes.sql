-- The sending accounts, the refresh tokens that drive them, their health log,
-- and the org-wide alert feed that Phase 2 raises into.
--
-- Nothing here sends anything. It is the substrate the scheduler (0015) and the
-- dispatcher sit on.

-- ---------------------------------------------------------------------------
-- The operator's own clock
-- ---------------------------------------------------------------------------
-- Prospect-local governs WHEN a send lands. Mailbox-local governs how many may
-- land at all, because a daily cap is a Gmail reputation limit on the sending
-- account and resets in the operator's day, not the prospect's. Collapsing the
-- two silently over-sends.
--
-- This is the default a newly connected mailbox inherits. It is not a guess in
-- the sense CLAUDE.md forbids: that rule is about deriving a PROSPECT's zone
-- from their address, where being wrong corrupts the send time. Here the
-- operator can see and correct their own zone on the mailboxes screen, and the
-- worst case is a cap window offset by a few hours.

alter table org_settings
  add column operator_timezone text not null default 'America/New_York';

-- ---------------------------------------------------------------------------
-- mailboxes
-- ---------------------------------------------------------------------------

create table mailboxes (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,

  -- The operator this mailbox belongs to. ON DELETE SET NULL rather than
  -- CASCADE: offboarding a person must not silently take a mailbox (and its
  -- in-flight sequence) with it. An orphaned mailbox shows up unowned on the
  -- mailboxes screen, which is a decision for a human.
  user_id    uuid references auth.users(id) on delete set null,

  email      text not null,
  email_norm text generated always as (app.normalize_email(email)) stored,
  display_name text,
  provider   mailbox_provider not null default 'gmail',

  -- The mailbox's OWN zone. See the note above; this is the zone daily_cap
  -- resets in, and it is deliberately a separate column from anything on leads.
  timezone   text not null default 'America/New_York',

  -- Gmail's own limit for a Workspace account is far higher; this is a
  -- reputation budget, not a quota. Ramp starts low and steps up.
  daily_cap  smallint not null default 20,
  ramp_step  smallint not null default 0,
  ramp_started_on date,

  -- Two different kinds of "not sending". Paused is a human decision and is
  -- reversible from the UI. Disconnected means the refresh token stopped
  -- working, which needs a re-consent, so they must not be the same flag.
  paused_at       timestamptz,
  disconnected_at timestamptz,

  is_sendable boolean generated always as (
    paused_at is null and disconnected_at is null
  ) stored,

  last_send_at   timestamptz,

  -- Gmail history cursor for the reply poller. Text, not bigint: Google
  -- documents historyId as an opaque unsigned value and only promises it is
  -- monotonic, so storing it as a number invites arithmetic on it.
  last_history_id text,
  last_polled_at  timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint mailboxes_cap_range check (daily_cap between 0 and 500),
  constraint mailboxes_ramp_nonneg check (ramp_step >= 0)
);

-- One row per address per org. Normalized, so "Ojas@…" and "ojas@…" cannot
-- both be connected and each spend a full cap.
create unique index mailboxes_org_email_key on mailboxes (org_id, email_norm);
create index mailboxes_org_sendable_idx on mailboxes (org_id) where is_sendable;

create trigger mailboxes_set_updated_at before update on mailboxes
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- mailbox_secrets
-- ---------------------------------------------------------------------------
-- Split from `mailboxes` for one reason: the mailbox row is read by the UI on
-- every page load, and a refresh token must never be one `select *` away from a
-- browser. This table has RLS on and NO POLICIES AT ALL, plus the grants
-- Supabase hands new public tables are revoked outright. Only the service role
-- — meaning only app/api/auth/google/callback and the cron routes — can see it.

create table mailbox_secrets (
  mailbox_id   uuid primary key references mailboxes(id) on delete cascade,

  refresh_token text not null,

  -- Cached so a dispatch run of forty sends does not mint forty access tokens.
  access_token  text,
  access_token_expires_at timestamptz,

  -- Recorded verbatim from Google's grant. gmail.modify must never appear here;
  -- Instantly's warmup mail lives in these same mailboxes and the app is
  -- structurally incapable of archiving, labelling or marking it read.
  scope text not null,

  connected_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger mailbox_secrets_set_updated_at before update on mailbox_secrets
  for each row execute function app.set_updated_at();

alter table mailbox_secrets enable row level security;
revoke all on table mailbox_secrets from anon, authenticated;

-- ---------------------------------------------------------------------------
-- mailbox_events — the health log
-- ---------------------------------------------------------------------------
-- Append-only by convention rather than by trigger: unlike lead_events nothing
-- derives from it, so a bad row is noise rather than a corrupted pipeline state.

create table mailbox_events (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  mailbox_id uuid not null references mailboxes(id) on delete cascade,
  kind       mailbox_health_kind not null,
  detail     text,
  payload    jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index mailbox_events_mailbox_idx
  on mailbox_events (mailbox_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- alerts
-- ---------------------------------------------------------------------------
-- The alert_kind enum has existed since 0001 with nothing to put in it. The
-- planner needs somewhere to raise cap_exhausted, and the dispatcher needs
-- mailbox_auth, so it lands here.
--
-- dedupe_token exists for the same reason it does on lead_events: a planner
-- that runs every ten minutes must not produce a hundred identical
-- "cap exhausted" rows before anyone looks.

create table alerts (
  id       uuid primary key default gen_random_uuid(),
  org_id   uuid not null references orgs(id) on delete cascade,
  kind     alert_kind not null,

  lead_id    uuid references leads(id) on delete cascade,
  mailbox_id uuid references mailboxes(id) on delete cascade,

  message  text not null,
  payload  jsonb not null default '{}'::jsonb,

  dedupe_token text,

  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  unique (org_id, kind, dedupe_token)
);

create index alerts_open_idx on alerts (org_id, created_at desc)
  where acknowledged_at is null;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table mailboxes      enable row level security;
alter table mailbox_events enable row level security;
alter table alerts         enable row level security;

-- Both operators see both mailboxes: the queue shows which account a send will
-- go out from, and "why is nothing sending" is usually answered by the other
-- person's mailbox being paused.
create policy mailboxes_select on mailboxes
  for select to authenticated
  using (org_id = app.current_org_id());

-- No INSERT policy. A mailbox row is created by the OAuth callback, which is
-- the only place that has a refresh token to pair with it. Inserting one from a
-- browser would produce a mailbox that can never send.

-- Pausing, renaming, retiming and re-capping are ordinary operator actions on
-- your own mailbox; an admin may do it to either.
create policy mailboxes_update on mailboxes
  for update to authenticated
  using (
    org_id = app.current_org_id()
    and (user_id = auth.uid() or app.is_admin())
  )
  with check (
    org_id = app.current_org_id()
    and (user_id = auth.uid() or app.is_admin())
  );

create policy mailboxes_delete on mailboxes
  for delete to authenticated
  using (org_id = app.current_org_id() and app.is_admin());

create policy mailbox_events_select on mailbox_events
  for select to authenticated
  using (org_id = app.current_org_id());

-- Health events are written by the dispatcher and the poller, both service
-- role. No insert policy for the same reason as lead_events' machine types: a
-- browser must not be able to fabricate "this mailbox is fine".

create policy alerts_select on alerts
  for select to authenticated
  using (org_id = app.current_org_id());

-- Acknowledging is the only thing a human does to an alert.
create policy alerts_update on alerts
  for update to authenticated
  using (org_id = app.current_org_id())
  with check (org_id = app.current_org_id());

-- ---------------------------------------------------------------------------
-- Guard: the columns the OAuth callback owns
-- ---------------------------------------------------------------------------
-- mailboxes_update above lets an operator edit their own mailbox, and PostgREST
-- takes a whole row. Without this, "change my daily cap" is one crafted request
-- away from also rewriting the address the tokens belong to, which would point
-- a live grant at a different mailbox and make every subsequent send go out
-- from an account the tokens do not match.
--
-- Unlike the guards on leads and lead_events, this one does NOT bind the
-- service role, and the difference is deliberate. Those two protect derived
-- state that no caller should ever write by hand. This one protects columns
-- that the OAuth callback and the sending jobs are precisely the right writers
-- of — last_send_at, last_history_id, disconnected_at — and every one of those
-- callers holds the service key. Binding it here would mean the guard's only
-- effect was forcing each of them to set a bypass flag first.

create or replace function app.mailboxes_guard_protected_columns()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- PostgREST does SET LOCAL ROLE, so this is the service key rather than a
  -- browser session.
  if current_user = 'service_role'
     or coalesce(current_setting('app.bypass_mailbox_guard', true), 'off') = 'on'
  then
    return new;
  end if;

  if new.org_id is distinct from old.org_id then
    raise exception 'org_id is immutable' using errcode = '42501';
  end if;

  if new.email is distinct from old.email
     or new.provider is distinct from old.provider then
    raise exception
      'the address is fixed by the Google grant. Reconnect the mailbox instead.'
      using errcode = '42501';
  end if;

  if new.disconnected_at is distinct from old.disconnected_at
     or new.last_history_id is distinct from old.last_history_id
     or new.last_send_at is distinct from old.last_send_at then
    raise exception 'that column is maintained by the sending and polling jobs'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger mailboxes_guard_protected before update on mailboxes
  for each row execute function app.mailboxes_guard_protected_columns();
