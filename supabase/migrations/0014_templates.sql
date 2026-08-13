-- Outreach copy, and the linter that decides whether a piece of it is allowed
-- to go live.
--
-- The lint runs in a trigger rather than only in the app, for the same reason
-- status is derived in the database: a rule that lives only in the UI is a rule
-- that holds until the first time somebody writes the row another way. Here
-- that "another way" is real — the templates screen, a psql session during an
-- incident, and a future seeding script are three different writers.
--
-- lib/templates/lint.ts mirrors app.template_lint() exactly, so the editor can
-- show violations before save. tests/integration/template-lint-parity.test.ts
-- runs shared vectors through both and asserts identical rule codes.

-- ---------------------------------------------------------------------------
-- The variable vocabulary
-- ---------------------------------------------------------------------------
-- Mirrors TEMPLATE_VARIABLES in lib/templates/lint.ts. A body that interpolates
-- anything else renders those braces verbatim into a live email, so an unknown
-- name is a lint failure rather than a silent passthrough.

create or replace function app.template_variables() returns text[]
language sql immutable parallel safe as $$
  select array[
    'first_name', 'last_name', 'company_name',
    'city', 'state', 'industry',
    'audit_time_local', 'audit_day_local', 'audit_outcome', 'response_delay',
    'demo_url', 'sender_name'
  ]::text[];
$$;

-- ---------------------------------------------------------------------------
-- The linter
-- ---------------------------------------------------------------------------
-- Returns the rule codes violated, in a fixed order. Empty means clean.
--
-- Every pattern below has a twin in lib/templates/lint.ts. Postgres `\y` and
-- JavaScript `\b` agree on where a word boundary is, and both engines treat
-- [A-Za-z0-9_] as the word class, which is what makes the parity test pass
-- rather than merely usually pass.

create or replace function app.template_lint(p_subject text, p_body text)
returns text[]
language plpgsql immutable parallel safe set search_path = '' as $$
declare
  v_rules   text[] := '{}';
  v_subject text := coalesce(p_subject, '');
  v_body    text := coalesce(p_body, '');
  v_asks    int;
  v_unknown boolean;
begin
  if btrim(v_subject) = '' then
    v_rules := v_rules || 'empty_subject';
  end if;

  -- Everything below reads the body. An empty one fails all of them at once,
  -- and reporting that five ways is not more useful than reporting it once.
  if btrim(v_body) = '' then
    return v_rules || 'empty_body';
  end if;

  -- U+2014 EM DASH and U+2013 EN DASH. Both: an en dash used as a clause break
  -- reads identically and is the obvious workaround.
  if v_subject ~ '[—–]' or v_body ~ '[—–]' then
    v_rules := v_rules || 'em_dash';
  end if;

  -- Loss framing. A vocabulary rather than a sentiment model, because this has
  -- to be one line of SQL: a false negative costs one rewrite, a false positive
  -- would let bland copy through.
  if v_body !~* '\y(miss|misses|missed|missing|lose|loses|losing|lost|slip|slips|slipping|unanswered|ignored|leak|leaks|leaking|costing|walks away|walk away|walking away|never hears back|never hear back|straight to voicemail|goes to voicemail|no one answers|nobody answers|going elsewhere|somewhere else|someone else)\y' then
    v_rules := v_rules || 'loss_frame';
  end if;

  -- The binary close: a question whose own sentence also contains "or".
  -- Bounded by sentence punctuation, so an "or" three sentences earlier does
  -- not satisfy it.
  if v_body !~* '[^.!?]*\yor\y[^.!?]*\?' then
    v_rules := v_rules || 'binary_close';
  end if;

  v_asks := length(v_body) - length(replace(v_body, '?', ''));
  if v_asks <> 1 then
    v_rules := v_rules || 'one_ask';
  end if;

  -- Aliased as m(parts) rather than bare `m`: a set-returning function in FROM
  -- names its single column after the alias, and being explicit here is the
  -- difference between reading a capture group and reading a whole row.
  select exists (
    select 1
      from regexp_matches(
             v_subject || ' ' || v_body,
             '\{\{\s*([a-zA-Z_]+)\s*\}\}',
             'g'
           ) as m(parts)
     where lower(parts[1]) <> all (app.template_variables())
  ) into v_unknown;

  if v_unknown then
    v_rules := v_rules || 'unknown_variable';
  end if;

  return v_rules;
end;
$$;

comment on function app.template_lint(text, text) is
  'Copy constraints from the brief: no em dashes, loss-framed CTA, '
  'binary-choice close, one ask per email, and only variables that exist. '
  'Mirrored by lib/templates/lint.ts.';

-- ---------------------------------------------------------------------------
-- templates
-- ---------------------------------------------------------------------------

create table templates (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,

  name   text not null,

  -- Which touch in the cadence this is. T1 is the first email; T2-T4 are the
  -- follow-ups the planner spaces at +3, +4 and +5 business days.
  step_number smallint not null,

  -- NULL means "either angle". A template pinned to an angle only ever renders
  -- for leads audited that way, which is what lets soft-text copy quote a text
  -- and voicemail copy quote a voicemail.
  angle_type angle_type,

  subject text not null,
  body    text not null,

  -- Gates the step on a built demo. Readiness lives in leads.demo_ready_at and
  -- deliberately does not advance status (see the rank table in 0004), so this
  -- is the only thing that can hold a follow-up back for it.
  requires_demo boolean not null default false,

  is_active boolean not null default false,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint templates_step_range check (step_number between 1 and 4),
  unique (org_id, name)
);

-- At most one live template per step per angle. Without this the planner would
-- have to pick between two active candidates, and "whichever the index returned
-- first" is not a decision anyone made.
--
-- Two indexes rather than one over `coalesce(angle_type::text, '*')`, because
-- casting an enum to text is STABLE and not IMMUTABLE (labels can be renamed),
-- so Postgres refuses it in an index expression. `NULLS NOT DISTINCT` would
-- also express this in one line, but only on PG15 and up; a pair of partial
-- indexes says the same thing on any version.
create unique index templates_active_step_angle_key
  on templates (org_id, step_number, angle_type)
  where is_active and angle_type is not null;

-- The "either angle" slot for that step.
create unique index templates_active_step_any_key
  on templates (org_id, step_number)
  where is_active and angle_type is null;

create index templates_org_step_idx on templates (org_id, step_number);

create trigger templates_set_updated_at before update on templates
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- The gate
-- ---------------------------------------------------------------------------
-- A draft may be as bad as you like. Activating it is the moment the rules
-- apply, because that is the moment it can reach a prospect.

create or replace function app.templates_enforce_lint() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_rules text[];
begin
  if not new.is_active then
    return new;
  end if;

  v_rules := app.template_lint(new.subject, new.body);

  if array_length(v_rules, 1) > 0 then
    raise exception 'template does not lint clean: %', array_to_string(v_rules, ', ')
      using errcode = '23514',
            hint = 'No em dashes, loss-framed CTA, one binary-choice question, '
                   'and only variables that exist.';
  end if;

  return new;
end;
$$;

create trigger templates_lint_before_activate
  before insert or update on templates
  for each row execute function app.templates_enforce_lint();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Copy is a shared asset. Either operator may write and activate one; only an
-- admin may delete, because a template referenced by a sent scheduled_send is
-- part of the audit trail of what was actually said.

alter table templates enable row level security;

create policy templates_select on templates
  for select to authenticated
  using (org_id = app.current_org_id());

create policy templates_insert on templates
  for insert to authenticated
  with check (org_id = app.current_org_id() and created_by = auth.uid());

create policy templates_update on templates
  for update to authenticated
  using (org_id = app.current_org_id())
  with check (org_id = app.current_org_id());

create policy templates_delete on templates
  for delete to authenticated
  using (org_id = app.current_org_id() and app.is_admin());
