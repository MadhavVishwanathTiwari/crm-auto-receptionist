-- A fifth background job: the nightly catch-up of each mailbox's Sent folder.
--
-- The app records every email it sends, and poll-replies records what comes
-- back. An email an operator sends straight from Gmail is recorded by nothing,
-- and /write then offers that lead a step it is already past: on 12 Sep that
-- was 122 of Ojas's leads (0042). reconcile-mailboxes reads the last three days
-- of every connected Sent folder once a night and records what it finds through
-- record_mailbox_touches(). See app/api/cron/reconcile-mailboxes/route.ts.
--
-- The hour. pg_cron here runs in UTC. 23:30 UTC is 05:00 in India, after the
-- operators' evening of sending and before their day starts, and 19:30 on the
-- US east coast, after the business day the dispatcher sends in. A west-coast
-- send can still be in flight then. That lead is reported `in_flight` and left
-- alone, and three days of lookback means the next night records it.
--
-- The three functions below each name the jobs, so each is restated in full
-- from its latest version (0041, 0041 and 0020) with the new job added.

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
  perform cron.schedule('dispatch-sends', '* * * * *',
    $job$select app.call_job('dispatch-sends')$job$);
  perform cron.schedule('poll-replies', '*/10 * * * *',
    $job$select app.call_job('poll-replies')$job$);
  perform cron.schedule('reconcile-mailboxes', '30 23 * * *',
    $job$select app.call_job('reconcile-mailboxes')$job$);

  return 'scheduled: resolve-timezones, plan-sends, dispatch-sends, poll-replies, reconcile-mailboxes';
end;
$$;

comment on function app.enable_background_jobs() is
  'Schedules the five jobs, once vault holds app_base_url and cron_secret. Idempotent.';

create or replace function app.disable_background_jobs() returns text
language plpgsql security definer set search_path = '' as $$
declare
  job text;
begin
  foreach job in array array[
    'resolve-timezones', 'plan-sends', 'dispatch-sends', 'poll-replies', 'reconcile-mailboxes'
  ]
  loop
    if exists (select 1 from cron.job j where j.jobname = job) then
      perform cron.unschedule(job);
    end if;
  end loop;

  return 'unscheduled. Nothing runs by itself now.';
end;
$$;

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
  where j.jobname in (
    'resolve-timezones', 'plan-sends', 'dispatch-sends', 'poll-replies', 'reconcile-mailboxes'
  );
$$;

revoke all on function public.background_jobs_status() from public;
grant execute on function public.background_jobs_status() to authenticated;

-- Schedule it now only if the others are already running. A deployment whose
-- jobs were turned off with app.disable_background_jobs() stays off: a
-- migration is not the place to switch anything back on. Same rule as 0041.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'dispatch-sends') then
    perform cron.schedule('reconcile-mailboxes', '30 23 * * *',
      $job$select app.call_job('reconcile-mailboxes')$job$);
    raise notice 'reconcile-mailboxes scheduled for 23:30 UTC daily';
  else
    raise notice 'background jobs are off; reconcile-mailboxes left unscheduled';
  end if;
end;
$$;
