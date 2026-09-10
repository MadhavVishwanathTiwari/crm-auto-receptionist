-- One email every 10 minutes or so per mailbox, give or take five, never two at
-- once.
--
-- Nothing spaced sends before this. A slot's minute is chosen by hash, which
-- spreads a day's sends on average and says nothing about any two of them: two
-- can land a minute apart, or on the same minute. And the dispatcher ran every
-- five minutes and sent everything due in one burst, so sends booked for 22:41
-- and 22:44 both left at 22:45, seconds apart, from the same account. A cold
-- account sending in bursts is exactly the pattern a reputation system is
-- looking for.
--
-- Two layers, because they answer different questions:
--
--   HERE, at claim: the guarantee. After a mailbox sends, it may not send again
--   until a random 5-15 minutes have passed (org_settings, adjustable), and it
--   sends at most one email per dispatcher run. This is the only place that
--   knows when a mailbox actually last sent, so it is the only place that can
--   promise a gap.
--
--   lib/scheduler/book.ts, at booking: honesty. Bookings on one mailbox are
--   kept at least the MAXIMUM gap apart, so a booked send is never held here
--   for longer than a dispatcher tick. The time /write promises stays the time
--   it leaves, and nothing drifts past slot_grace_minutes into a roll-forward.
--
-- The dispatcher moves to every minute. At five, the gap would be rounded up to
-- a multiple of five and "random" would come out as 5, 10 or 15.

-- ---------------------------------------------------------------------------
-- The knobs
-- ---------------------------------------------------------------------------

alter table org_settings
  add column send_gap_min_minutes smallint not null default 5,
  add column send_gap_max_minutes smallint not null default 15,
  add constraint org_settings_send_gap check (
    send_gap_min_minutes between 1 and 120
    and send_gap_max_minutes between send_gap_min_minutes and 120
  );

comment on column org_settings.send_gap_min_minutes is
  'Shortest gap between two sends from one mailbox. The actual gap is random between min and max.';
comment on column org_settings.send_gap_max_minutes is
  'Longest gap between two sends from one mailbox, and how far apart bookings on one mailbox are kept.';

-- ---------------------------------------------------------------------------
-- The gate
-- ---------------------------------------------------------------------------
-- Null means free. Written only by claim_due_sends(), under the mailbox's
-- advisory lock, so two dispatchers can never both read "free".

alter table mailboxes add column next_send_not_before timestamptz;

-- Restated from 0013 with the new column among the ones the jobs maintain. An
-- operator who could clear it could defeat the spacing with one request.
create or replace function app.mailboxes_guard_protected_columns()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- PostgREST does SET LOCAL ROLE, so this is the service key rather than a
  -- browser session. A SECURITY DEFINER function is neither: inside one,
  -- current_user is its owner, which is why every definer that writes these
  -- columns sets the bypass instead (0040).
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
     or new.last_send_at is distinct from old.last_send_at
     or new.next_send_not_before is distinct from old.next_send_not_before then
    raise exception 'that column is maintained by the sending and polling jobs'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- claim_due_sends, one at a time per mailbox
-- ---------------------------------------------------------------------------
-- Restated in full from 0040 (which restated 0016). Three changes, marked:
-- skip a mailbox whose gap has not passed, take at most one send from it, and
-- close the gate behind that send.
--
-- The gate closes at CLAIM, not when Gmail answers. The next dispatcher run can
-- start before this one has reached the Gmail call, and the claim is the only
-- step serialized per mailbox. A gap measured from the send would leave a
-- window in which a second run sees the mailbox as free.

create or replace function public.claim_due_sends(
  p_org_id uuid,
  p_limit  int default 25
) returns setof public.scheduled_sends
language plpgsql security definer set search_path = '' as $$
declare
  v_settings  public.org_settings;
  v_mailbox   record;
  v_remaining int := p_limit;
  v_claimed   int;
  v_used      int;
  v_allowed   int;
  v_today     date;
  v_token     uuid := gen_random_uuid();
  v_previous  text;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'p_limit must be between 1 and 500' using errcode = '22023';
  end if;

  select * into v_settings from public.org_settings where org_id = p_org_id;
  if not found then
    return;
  end if;

  -- The kill switch.
  if v_settings.dry_run then
    return;
  end if;

  for v_mailbox in
    select m.id, m.timezone, m.daily_cap
      from public.mailboxes m
     where m.org_id = p_org_id
       and m.is_sendable
     order by m.id
  loop
    exit when v_remaining <= 0;

    perform pg_advisory_xact_lock(hashtextextended(v_mailbox.id::text, 0));

    -- 0041: still inside its gap. Read under the lock, not from the loop's
    -- row, which was read before the lock was taken.
    if exists (
      select 1 from public.mailboxes m
       where m.id = v_mailbox.id
         and m.next_send_not_before > now()
    ) then
      continue;
    end if;

    v_today := (timezone(v_mailbox.timezone, now()))::date;

    select count(*) into v_used
      from public.scheduled_sends s
     where s.mailbox_id = v_mailbox.id
       and s.cap_date = v_today
       and s.status in ('claimed', 'sending', 'sent');

    -- 0041: one per mailbox per run, however many are due.
    v_allowed := least(v_remaining, v_mailbox.daily_cap - v_used, 1);
    if v_allowed <= 0 then
      continue;
    end if;

    return query
    with due as (
      select s.id
        from public.scheduled_sends s
        join public.leads l on l.id = s.lead_id
       where s.org_id = p_org_id
         and s.mailbox_id = v_mailbox.id
         and s.status = 'planned'
         and s.scheduled_at <= now()
         and s.scheduled_at > now() - make_interval(mins => v_settings.slot_grace_minutes)
         and l.halted_at is null
         and l.terminal_outcome is null
         and l.archived_at is null
         -- 0040: an earlier send to this lead may have gone out unrecorded.
         and not exists (
           select 1 from public.scheduled_sends x
            where x.lead_id = s.lead_id
              and x.status = 'failed'
              and x.error_code = 'stalled'
         )
       order by s.scheduled_at
       limit v_allowed
       for update of s skip locked
    )
    update public.scheduled_sends s
       set status      = 'claimed',
           claimed_at  = now(),
           claim_token = v_token,
           cap_date    = v_today,
           attempts    = s.attempts + 1
     where s.id in (select id from due)
    returning s.*;

    get diagnostics v_claimed = row_count;
    v_remaining := v_remaining - v_claimed;

    -- 0041: close the gate behind it, for a random gap between min and max.
    if v_claimed > 0 then
      v_previous := coalesce(current_setting('app.bypass_mailbox_guard', true), 'off');
      perform set_config('app.bypass_mailbox_guard', 'on', true);

      update public.mailboxes m
         set next_send_not_before = now() + make_interval(secs =>
               (v_settings.send_gap_min_minutes
                + random() * (v_settings.send_gap_max_minutes
                              - v_settings.send_gap_min_minutes)) * 60)
       where m.id = v_mailbox.id;

      perform set_config('app.bypass_mailbox_guard', v_previous, true);
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The dispatcher, every minute
-- ---------------------------------------------------------------------------
-- Restated from 0020 with one schedule changed. Each run now sends at most one
-- email per mailbox, so it is short: the reason 0020 chose five minutes (a
-- batch has to finish inside the function's wall clock) no longer applies, and
-- a one-minute tick is what lets a random gap come out random.

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

  return 'scheduled: resolve-timezones, plan-sends, dispatch-sends, poll-replies';
end;
$$;

-- Reschedule only what is already running. A deployment whose jobs were turned
-- off with app.disable_background_jobs() stays off: a migration is not the
-- place to switch a sender back on. cron.schedule() updates a job by name.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'dispatch-sends') then
    perform cron.schedule('dispatch-sends', '* * * * *',
      $job$select app.call_job('dispatch-sends')$job$);
    raise notice 'dispatch-sends rescheduled to every minute';
  else
    raise notice 'dispatch-sends is not scheduled; left as it is';
  end if;
end;
$$;
