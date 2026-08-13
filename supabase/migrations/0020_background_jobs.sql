-- The scheduler.
--
-- Four routes exist and nothing has ever called them. This is what calls them.
--
-- pg_cron rather than Vercel cron, for one decisive reason: the dispatcher has
-- to run every five minutes and the planner every fifteen, and Vercel's Hobby
-- plan permits one cron invocation per day. Putting the schedule in Postgres
-- also keeps it in a migration, where every other rule in this system already
-- lives, rather than in a hosting dashboard nobody diffs.
--
-- The URL and the secret live in Vault and are read at CALL time, not baked
-- into the schedule. Rotating CRON_SECRET is then one vault update rather than
-- four unschedule/reschedule pairs, and the secret never appears in cron.job,
-- which app.background_jobs_status() exposes to the app.
--
-- Nothing here schedules anything until both secrets exist. A job scheduled
-- against a missing URL would fail every five minutes, and a log full of
-- identical failures is how a real failure goes unnoticed.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- The call
-- ---------------------------------------------------------------------------

create or replace function app.call_job(job text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  base    text;
  secret  text;
  request bigint;
begin
  select decrypted_secret into base
    from vault.decrypted_secrets where name = 'app_base_url';
  select decrypted_secret into secret
    from vault.decrypted_secrets where name = 'cron_secret';

  if base is null or btrim(base) = '' then
    raise exception 'vault secret app_base_url is missing, so % cannot be called', job;
  end if;
  if secret is null or btrim(secret) = '' then
    raise exception 'vault secret cron_secret is missing, so % would 401', job;
  end if;

  -- btrim both, and this is not defensive programming for its own sake: a
  -- secret pasted into Vault with a trailing newline produces a 401 whose body
  -- says "unauthorized" and nothing about why, and that failure mode has cost
  -- this stack a day before. requireBearer() trims the other side too.
  select net.http_post(
    url := rtrim(btrim(base), '/') || '/api/cron/' || job,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || btrim(secret),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) into request;

  return request;
end;
$$;

comment on function app.call_job(text) is
  'POSTs /api/cron/<job> with the Vault-held bearer. Called by cron.schedule.';

-- ---------------------------------------------------------------------------
-- Turning the schedule on and off
-- ---------------------------------------------------------------------------
-- Cadence, and why each one:
--
--   resolve-timezones  hourly. A lead with no zone is never scheduled, and the
--                      only thing that produces zones is this. Hourly is plenty
--                      because zones arrive in import-sized bursts.
--   plan-sends         every 15 minutes. It books slots hours or days ahead, so
--                      latency here costs nothing; running it often is about
--                      picking up a lead the moment an operator audits it.
--   dispatch-sends     every 5 minutes. This one IS the latency: a send booked
--                      for 09:12 goes out on the first run after 09:12, and
--                      org_settings.slot_grace_minutes (20 by default) is the
--                      window before it rolls forward instead.
--   poll-replies       every 10 minutes. A reply halts the rest of the
--                      sequence, and the next touch is business-days away.

create or replace function app.enable_background_jobs() returns text
language plpgsql security definer set search_path = '' as $$
declare
  missing text[] := '{}';
begin
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Supabase Vault is not enabled on this project';
  end if;

  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'app_base_url' and btrim(decrypted_secret) <> ''
  ) then
    -- Cast required: `text[] || 'literal'` resolves to array || array and
    -- Postgres then tries to parse the literal as an array.
    missing := missing || 'app_base_url'::text;
  end if;

  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'cron_secret' and btrim(decrypted_secret) <> ''
  ) then
    missing := missing || 'cron_secret'::text;
  end if;

  if array_length(missing, 1) > 0 then
    return 'not scheduled, missing vault secret(s): ' || array_to_string(missing, ', ');
  end if;

  perform cron.schedule('resolve-timezones', '7 * * * *',
    $job$select app.call_job('resolve-timezones')$job$);
  perform cron.schedule('plan-sends', '*/15 * * * *',
    $job$select app.call_job('plan-sends')$job$);
  perform cron.schedule('dispatch-sends', '*/5 * * * *',
    $job$select app.call_job('dispatch-sends')$job$);
  perform cron.schedule('poll-replies', '*/10 * * * *',
    $job$select app.call_job('poll-replies')$job$);

  return 'scheduled: resolve-timezones, plan-sends, dispatch-sends, poll-replies';
end;
$$;

create or replace function app.disable_background_jobs() returns text
language plpgsql security definer set search_path = '' as $$
declare
  job text;
begin
  foreach job in array array['resolve-timezones', 'plan-sends', 'dispatch-sends', 'poll-replies']
  loop
    if exists (select 1 from cron.job j where j.jobname = job) then
      perform cron.unschedule(job);
    end if;
  end loop;
  return 'unscheduled. Nothing runs by itself now.';
end;
$$;

comment on function app.enable_background_jobs() is
  'Schedules the four jobs, once vault holds app_base_url and cron_secret. Idempotent.';

-- ---------------------------------------------------------------------------
-- What the app is allowed to know about it
-- ---------------------------------------------------------------------------
-- The settings screen asks one question: is this thing running by itself yet,
-- and did the last run work. cron.job and cron.job_run_details are unreadable
-- by `authenticated`, so this definer function answers it and nothing else.
-- It returns no secret: the bearer lives in Vault and is read inside
-- app.call_job() at request time, so cron.job.command holds only a function
-- call. Keep it that way.

create or replace function public.background_jobs_status()
returns table (
  job          text,
  schedule     text,
  active       boolean,
  last_run_at  timestamptz,
  last_status  text
)
language sql stable security definer set search_path = '' as $$
  select
    j.jobname::text,
    j.schedule::text,
    j.active,
    d.start_time,
    d.status::text
  from cron.job j
  left join lateral (
    select r.start_time, r.status
    from cron.job_run_details r
    where r.jobid = j.jobid
    order by r.start_time desc
    limit 1
  ) d on true
  where j.jobname in
    ('resolve-timezones', 'plan-sends', 'dispatch-sends', 'poll-replies');
$$;

revoke all on function public.background_jobs_status() from public;
grant execute on function public.background_jobs_status() to authenticated;

-- ---------------------------------------------------------------------------
-- Schedule now if this deployment is already provisioned
-- ---------------------------------------------------------------------------
-- On a fresh `db:reset` against a project whose Vault is already populated,
-- this restores the schedule with no manual step. On one that is not, it does
-- nothing and says so. Either way the migration applies.

do $$
declare
  outcome text;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    raise notice 'Vault not enabled: background jobs left unscheduled.';
    return;
  end if;
  select app.enable_background_jobs() into outcome;
  raise notice '%', outcome;
end;
$$;
