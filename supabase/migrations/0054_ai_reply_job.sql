-- Scheduling the assistant, and making poll-replies fast enough for it.
--
-- Two schedule changes:
--
--   ai-replies, every two minutes. The gate is "this reply arrived more than
--   ai_reply_delay_minutes ago", so the tick only has to be fast relative to
--   that. A run with the mode off returns before its first Gmail call.
--
--   poll-replies, from */10 to */5. Without it the five-minute promise is a
--   lie: a reply is invisible to this app for up to ten minutes before the
--   clock the assistant reads can even start, so the operator's real grace
--   would be five to fifteen minutes with no way to know which. At two
--   mailboxes a poll that finds nothing is one Gmail request.
--
-- The three functions below each NAME the jobs, so each is restated in full
-- from 0044 with the new one added. A partial copy would silently drop a job
-- from disable_background_jobs() and leave it running after somebody turned
-- everything off.

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
  perform cron.schedule('poll-replies', '*/5 * * * *',
    $job$select app.call_job('poll-replies')$job$);
  perform cron.schedule('ai-replies', '*/2 * * * *',
    $job$select app.call_job('ai-replies')$job$);
  perform cron.schedule('reconcile-mailboxes', '30 23 * * *',
    $job$select app.call_job('reconcile-mailboxes')$job$);

  return 'scheduled: resolve-timezones, plan-sends, dispatch-sends, poll-replies, ai-replies, reconcile-mailboxes';
end;
$$;

comment on function app.enable_background_jobs() is
  'Schedules the six jobs, once vault holds app_base_url and cron_secret. Idempotent.';

create or replace function app.disable_background_jobs() returns text
language plpgsql security definer set search_path = '' as $$
declare
  job text;
begin
  foreach job in array array[
    'resolve-timezones', 'plan-sends', 'dispatch-sends', 'poll-replies',
    'ai-replies', 'reconcile-mailboxes'
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
    'resolve-timezones', 'plan-sends', 'dispatch-sends', 'poll-replies',
    'ai-replies', 'reconcile-mailboxes'
  );
$$;

revoke all on function public.background_jobs_status() from public, anon;
grant execute on function public.background_jobs_status() to authenticated;

-- Schedule now only if the others are already running. A deployment whose jobs
-- were turned off with app.disable_background_jobs() stays off: a migration is
-- not the place to switch anything back on. Same rule as 0041 and 0044.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'dispatch-sends') then
    perform cron.schedule('ai-replies', '*/2 * * * *',
      $job$select app.call_job('ai-replies')$job$);
    perform cron.schedule('poll-replies', '*/5 * * * *',
      $job$select app.call_job('poll-replies')$job$);
    raise notice 'ai-replies scheduled every 2 minutes; poll-replies moved to every 5';
  else
    raise notice 'background jobs are off; ai-replies left unscheduled';
  end if;
end;
$$;
