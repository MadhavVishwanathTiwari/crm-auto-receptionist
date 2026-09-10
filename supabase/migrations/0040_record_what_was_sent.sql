-- Nothing the dispatcher sent was ever recorded as sent, and this is why.
--
-- mark_send_sent() (0016) ends by stamping mailboxes.last_send_at. The guard
-- 0013 put on mailboxes lets `current_user = 'service_role'` through and nobody
-- else. But mark_send_sent() is SECURITY DEFINER, owned by postgres, and inside
-- a definer function current_user IS the owner. So the guard saw `postgres`,
-- refused the column, and the exception rolled back the whole transaction: the
-- `sent` row, the `sent` event, the thread id and the stamp.
--
-- The dispatcher never read that RPC's error, so the row stayed in `sending`.
-- reap_stalled_sends() failed it as `stalled` fifteen minutes later, which is
-- right, and the planner, seeing no sent touch, booked the step again, which is
-- not. From 18 Aug to 10 Sep that was 247 emails, every one accepted by Gmail,
-- six businesses receiving the same first touch 38 to 41 times. No test had
-- ever called mark_send_sent().
--
-- Three things change here:
--
--   1. mark_send_sent() sets the mailbox guard's bypass, the way every definer
--      function that writes a guarded leads column sets app.bypass_lead_guard.
--      The guard is unchanged. Its service_role check is still right for writes
--      that arrive over PostgREST; it simply never covered code running as a
--      definer, and nothing said so.
--   2. An unknown outcome now holds the lead. 0016 says the reaper never
--      retries a stalled send because a wrong guess is a second email, and then
--      the planner retried it anyway by booking the step again. A trigger now
--      refuses any new dispatchable row for a lead with an unresolved `stalled`
--      send, binding the service role as the timezone guard does, until a
--      person says whether it went out.
--   3. The backlog is repairable: each stalled step is recorded once, from its
--      latest attempt, and the other attempts are marked as the repeats they
--      were. Admin only, dry run by default, button on /import.

-- ---------------------------------------------------------------------------
-- 1. mark_send_sent, able to finish
-- ---------------------------------------------------------------------------
-- Restated in full: `create or replace` swaps the whole body, and a partial
-- copy would silently drop the event insert.

create or replace function public.mark_send_sent(
  p_send_id      uuid,
  p_message_id   text,
  p_thread_id    text,
  p_rfc822_id    text,
  p_subject      text,
  p_body         text
) returns public.scheduled_sends
language plpgsql security definer set search_path = '' as $$
declare
  v_send     public.scheduled_sends;
  v_previous text;
begin
  if p_message_id is null or btrim(p_message_id) = '' then
    raise exception 'a sent send must carry its provider message id'
      using errcode = '22023';
  end if;

  update public.scheduled_sends s
     set status              = 'sent',
         sent_at             = now(),
         provider_message_id = p_message_id,
         provider_thread_id  = p_thread_id,
         rfc822_message_id   = p_rfc822_id,
         rendered_subject    = p_subject,
         rendered_body       = p_body,
         error_code          = null,
         error_detail        = null
   where s.id = p_send_id
     and s.status in ('claimed', 'sending')
  returning s.* into v_send;

  if not found then
    -- Already marked, or never claimed. Either way this call must not insert a
    -- second event, so report the current row and stop.
    select * into v_send from public.scheduled_sends where id = p_send_id;
    return v_send;
  end if;

  insert into public.lead_events (
    org_id, lead_id, type, actor_id, payload, scheduled_send_id, dedupe_token
  )
  values (
    v_send.org_id, v_send.lead_id, 'sent', null,
    jsonb_build_object(
      'step_number', v_send.step_number,
      'mailbox_id',  v_send.mailbox_id,
      'subject',     p_subject,
      'thread_id',   p_thread_id
    ),
    v_send.id, p_message_id
  )
  on conflict (lead_id, type, dedupe_token) do nothing;

  -- The line that failed on every send until this migration. current_user is
  -- `postgres` in here, not `service_role`, so the guard needs telling.
  v_previous := coalesce(current_setting('app.bypass_mailbox_guard', true), 'off');
  perform set_config('app.bypass_mailbox_guard', 'on', true);

  update public.mailboxes m
     set last_send_at = now()
   where m.id = v_send.mailbox_id;

  perform set_config('app.bypass_mailbox_guard', v_previous, true);

  return v_send;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The dispatcher's fallback when recording fails anyway
-- ---------------------------------------------------------------------------
-- Called only after Gmail has accepted the message, when mark_send_sent() has
-- raised. The email is out. What must not happen now is the row looking as if
-- nothing went out, so it is parked as `stalled` (which holds the lead, below)
-- carrying everything Gmail returned: recording it later then needs no
-- guesswork, and the follow-up can still thread onto it.
--
-- Touches nothing but this one row. Whatever broke mark_send_sent() is unknown
-- at this point, and the less this does the likelier it is to work.

create or replace function public.mark_send_unrecorded(
  p_send_id    uuid,
  p_message_id text,
  p_thread_id  text,
  p_rfc822_id  text,
  p_subject    text,
  p_body       text,
  p_detail     text
) returns public.scheduled_sends
language plpgsql security definer set search_path = '' as $$
declare
  v_send public.scheduled_sends;
begin
  update public.scheduled_sends s
     set status              = 'failed',
         error_code          = 'stalled',
         error_detail        = left(p_detail, 2000),
         provider_message_id = nullif(btrim(coalesce(p_message_id, '')), ''),
         provider_thread_id  = nullif(btrim(coalesce(p_thread_id, '')), ''),
         rfc822_message_id   = p_rfc822_id,
         rendered_subject    = p_subject,
         rendered_body       = p_body
   where s.id = p_send_id
     and s.status in ('claimed', 'sending')
  returning s.* into v_send;

  return v_send;
end;
$$;

revoke all on function public.mark_send_unrecorded(uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.mark_send_unrecorded(uuid, text, text, text, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. An unknown outcome holds the lead
-- ---------------------------------------------------------------------------
-- A `stalled` row means the dispatcher reached the Gmail call and nobody knows
-- what happened after. Until a person says, nothing more is booked for that
-- lead: not by the planner, not by /write, not by anything holding the service
-- key. The planner and the composer both check first so they can say why; this
-- is what makes the rule true for a writer that forgets to.

create index scheduled_sends_unresolved_idx
  on scheduled_sends (lead_id)
  where status = 'failed' and error_code = 'stalled';

create or replace function app.scheduled_sends_refuse_unknown_outcome()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Only rows that could still be dispatched. A row arriving already `sent`
  -- (the sheet backfill) is a record of the past, not an attempt.
  if new.status not in ('planned', 'blocked') then
    return new;
  end if;

  if exists (
    select 1 from public.scheduled_sends s
     where s.lead_id = new.lead_id
       and s.status = 'failed'
       and s.error_code = 'stalled'
  ) then
    raise exception
      'an earlier email to lead % may already have gone out, so nothing more is booked for it until somebody says whether it did',
      new.lead_id
      using errcode = '23514',
            hint = 'Resolve it on the lead: "It went out" or "It did not go out".';
  end if;

  return new;
end;
$$;

create trigger scheduled_sends_refuse_unknown_outcome
  before insert on scheduled_sends
  for each row execute function app.scheduled_sends_refuse_unknown_outcome();

-- The trigger stops new bookings. It does nothing about one already made:
-- after each stall the planner had usually re-booked the step, and that row is
-- `planned` and due. So the claimer skips a held lead as well. Without this,
-- the moment mark_send_sent() starts succeeding, every re-booked repeat would
-- go out and be recorded as if it were the first.
--
-- Restated in full from 0016 with that one condition added; see 0016 for the
-- reasoning behind the rest, all of which still holds.

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

    v_today := (timezone(v_mailbox.timezone, now()))::date;

    select count(*) into v_used
      from public.scheduled_sends s
     where s.mailbox_id = v_mailbox.id
       and s.cap_date = v_today
       and s.status in ('claimed', 'sending', 'sent');

    v_allowed := least(v_remaining, v_mailbox.daily_cap - v_used);
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
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Recording a send after the fact
-- ---------------------------------------------------------------------------
-- Shared by the operator's "it went out" and the admin repair, so the two can
-- never disagree about what a recorded send looks like. It is the same three
-- effects as mark_send_sent() -- the row, the `sent` event, the mailbox stamp --
-- dated when the email actually left rather than now, because T2's cadence is
-- counted from sent_at.
--
-- Not reachable over the API: `app` is not an exposed schema, and execute is
-- revoked besides. Its callers are definer functions that check who is asking.

create or replace function app.record_unrecorded_send(p_send_id uuid)
returns public.scheduled_sends
language plpgsql set search_path = '' as $$
declare
  v_send     public.scheduled_sends;
  v_previous text;
begin
  select * into v_send
    from public.scheduled_sends
   where id = p_send_id
     for update;

  if v_send.id is null then
    raise exception 'no such send' using errcode = '22023';
  end if;

  if v_send.status = 'sent' then
    return v_send;
  end if;

  -- sending_at is stamped by mark_send_sending() immediately before the Gmail
  -- call. A row without it never got that far and cannot have gone out, and
  -- recording it as sent would invent an email.
  if v_send.sending_at is null or v_send.status not in ('sending', 'failed') then
    raise exception 'that send never reached Gmail, so there is nothing to record'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.scheduled_sends s
     where s.lead_id = v_send.lead_id
       and s.step_number = v_send.step_number
       and s.id <> v_send.id
       and s.status in ('claimed', 'sending', 'sent')
  ) then
    raise exception 'step % of this lead already has another send in flight or recorded',
      v_send.step_number
      using errcode = '55006';
  end if;

  -- The re-booking of a touch that had in fact already gone out. The words
  -- stay on the row, so a hand-written one is not lost, only not sent twice.
  update public.scheduled_sends s
     set status = 'cancelled',
         outcome_reason = 'step ' || s.step_number
                          || ' had already gone out; recorded after the fact'
   where s.lead_id = v_send.lead_id
     and s.step_number = v_send.step_number
     and s.status in ('planned', 'blocked');

  update public.scheduled_sends s
     set status           = 'sent',
         sent_at          = s.sending_at,
         error_code       = null,
         error_detail     = null,
         outcome_reason   = 'recorded after the fact: Gmail accepted it and recording it failed at the time',
         -- A written send's words are final, so they ARE what went out. A
         -- template's rendering was never stored and is not reconstructed:
         -- a guess filed as "what we said" is worse than a blank.
         rendered_subject = coalesce(s.rendered_subject, s.composed_subject),
         rendered_body    = coalesce(s.rendered_body, s.composed_body)
   where s.id = v_send.id
  returning s.* into v_send;

  -- Gmail's id when the dispatcher parked one (mark_send_unrecorded), which is
  -- the same token mark_send_sent() would have used. Otherwise one per row, so
  -- a re-run inserts nothing.
  insert into public.lead_events (
    org_id, lead_id, type, actor_id, occurred_at, payload,
    scheduled_send_id, dedupe_token
  )
  values (
    v_send.org_id, v_send.lead_id, 'sent', null, v_send.sent_at,
    jsonb_build_object(
      'step_number', v_send.step_number,
      'mailbox_id',  v_send.mailbox_id,
      'subject',     v_send.rendered_subject,
      'thread_id',   v_send.provider_thread_id,
      'recorded_after_the_fact', true,
      'recorded_by', auth.uid()
    ),
    v_send.id,
    coalesce(v_send.provider_message_id, 'unrecorded:' || v_send.id::text)
  )
  on conflict (lead_id, type, dedupe_token) do nothing;

  v_previous := coalesce(current_setting('app.bypass_mailbox_guard', true), 'off');
  perform set_config('app.bypass_mailbox_guard', 'on', true);

  update public.mailboxes m
     set last_send_at = greatest(coalesce(m.last_send_at, v_send.sent_at), v_send.sent_at)
   where m.id = v_send.mailbox_id;

  perform set_config('app.bypass_mailbox_guard', v_previous, true);

  return v_send;
end;
$$;

revoke all on function app.record_unrecorded_send(uuid) from public;

-- ---------------------------------------------------------------------------
-- 5. A person resolves one
-- ---------------------------------------------------------------------------
-- The lead drawer's two buttons. Ownership through app.same_operator for the
-- 0032 reason: a strict claimed_by = auth.uid() refuses every lead madhav's
-- other account claimed.

create or replace function public.resolve_stalled_send(
  p_send_id  uuid,
  p_went_out boolean
) returns public.scheduled_sends
language plpgsql security definer set search_path = '' as $$
declare
  v_org     uuid := app.current_org_id();
  v_send    public.scheduled_sends;
  v_claimed uuid;
begin
  if v_org is null then
    raise exception 'not a member of any org' using errcode = '42501';
  end if;

  if p_went_out is null then
    raise exception 'say whether it went out' using errcode = '22023';
  end if;

  select * into v_send
    from public.scheduled_sends s
   where s.id = p_send_id
     and s.org_id = v_org;

  if v_send.id is null then
    raise exception 'no such send' using errcode = '22023';
  end if;

  select l.claimed_by into v_claimed from public.leads l where l.id = v_send.lead_id;

  if not (v_claimed is null
          or app.same_operator(v_claimed, auth.uid())
          or app.is_admin()) then
    raise exception 'that lead belongs to somebody else' using errcode = '42501';
  end if;

  if not (v_send.status = 'failed' and v_send.error_code = 'stalled') then
    raise exception 'that send is not waiting on a decision' using errcode = '22023';
  end if;

  if p_went_out then
    -- Another attempt at this step is already the recorded one, so this is a
    -- repeat of it. Only one row per step may be `sent`, and refusing here
    -- would leave the lead held by a row nobody can settle.
    if exists (
      select 1 from public.scheduled_sends s
       where s.lead_id = v_send.lead_id
         and s.step_number = v_send.step_number
         and s.status = 'sent'
    ) then
      update public.scheduled_sends s
         set error_code     = 'sent_unrecorded_repeat',
             outcome_reason = 'checked by an operator: this went out, as a repeat of the recorded send'
       where s.id = p_send_id
      returning s.* into v_send;
      return v_send;
    end if;

    return app.record_unrecorded_send(p_send_id);
  end if;

  -- It did not go out. The row stays `failed`, which is outside the live
  -- index, so the step can be booked again.
  update public.scheduled_sends s
     set error_code     = 'stalled_not_sent',
         outcome_reason = 'checked by an operator: this one did not go out'
   where s.id = p_send_id
  returning s.* into v_send;

  return v_send;
end;
$$;

revoke all on function public.resolve_stalled_send(uuid, boolean) from public, anon;
grant execute on function public.resolve_stalled_send(uuid, boolean) to authenticated;

comment on function public.resolve_stalled_send(uuid, boolean) is
  'Settles a send whose outcome is unknown. went_out records it as sent, dated '
  'when it left; otherwise the step may be booked again. Owner or admin.';

-- ---------------------------------------------------------------------------
-- 6. The backlog
-- ---------------------------------------------------------------------------
-- Every send the dispatcher made before this migration is a `stalled` row, and
-- most leads have many, one per repeat. Per lead and step: the LATEST attempt is
-- recorded as sent, because T2's cadence is counted from sent_at and the most
-- recent email is the one the prospect will measure the follow-up against. The
-- rest become `sent_unrecorded_repeat`. They did go out, but only one row per
-- step may be `sent` (scheduled_sends_lead_step_live), and a distinct code keeps
-- them out of the trigger above and visible as what they were.
--
-- `sending` rows past stall_minutes count too: the reaper may simply not have
-- got to them yet. Newer ones are left alone, since they may be in flight.
--
-- Admin only, dry run by default, re-runnable. One subtransaction per lead and
-- step, so one bad row reports an error instead of undoing the rest.

create or replace function public.repair_stalled_sends(
  p_dry_run boolean default true
) returns table (
  lead_id           uuid,
  company           text,
  step_number       smallint,
  attempts          integer,
  recorded_at       timestamptz,
  cancelled_planned integer,
  cancelled_written integer,
  outcome           text
)
language plpgsql security definer set search_path = '' as $$
declare
  v_org    uuid := app.current_org_id();
  v_stall  integer;
  v_group  record;
  v_latest uuid;
begin
  if v_org is null then
    raise exception 'not a member of any org' using errcode = '42501';
  end if;

  if not app.is_admin() then
    raise exception 'only an admin can repair sends' using errcode = '42501';
  end if;

  select o.stall_minutes into v_stall from public.org_settings o where o.org_id = v_org;
  v_stall := coalesce(v_stall, 15);

  for v_group in
    select s.lead_id       as g_lead,
           s.step_number   as g_step,
           l.company_name  as g_company,
           count(*)::int   as g_attempts,
           max(s.sending_at) as g_latest_at
      from public.scheduled_sends s
      join public.leads l on l.id = s.lead_id
     where s.org_id = v_org
       and s.sending_at is not null
       and (
         (s.status = 'failed' and s.error_code = 'stalled')
         or (s.status = 'sending'
             and s.sending_at < now() - make_interval(mins => v_stall))
       )
     group by s.lead_id, s.step_number, l.company_name
     order by max(s.sending_at)
  loop
    lead_id     := v_group.g_lead;
    company     := v_group.g_company;
    step_number := v_group.g_step;
    attempts    := v_group.g_attempts;
    recorded_at := v_group.g_latest_at;

    select count(*)::int,
           (count(*) filter (where s.composed_body is not null))::int
      into cancelled_planned, cancelled_written
      from public.scheduled_sends s
     where s.lead_id = v_group.g_lead
       and s.step_number = v_group.g_step
       and s.status in ('planned', 'blocked');

    -- Something for this step is on its way right now. Recording now could
    -- produce a second `sent` for it; the next run will see it settled.
    if exists (
      select 1 from public.scheduled_sends s
       where s.lead_id = v_group.g_lead
         and s.step_number = v_group.g_step
         and (s.status = 'claimed'
              or (s.status = 'sending'
                  and s.sending_at >= now() - make_interval(mins => v_stall)))
    ) then
      outcome := 'in flight, run again later';
      cancelled_planned := 0;
      cancelled_written := 0;
      return next;
      continue;
    end if;

    -- This step was recorded properly at some point, so every stalled attempt
    -- beside it is a repeat and nothing new gets recorded.
    if exists (
      select 1 from public.scheduled_sends s
       where s.lead_id = v_group.g_lead
         and s.step_number = v_group.g_step
         and s.status = 'sent'
    ) then
      outcome := 'already recorded, repeats marked';
      recorded_at := null;
      cancelled_planned := 0;
      cancelled_written := 0;

      if not p_dry_run then
        update public.scheduled_sends s
           set status       = 'failed',
               error_code   = 'sent_unrecorded_repeat',
               error_detail = 'went out through Gmail but was never recorded; '
                              'another send at this step is the recorded one'
         where s.lead_id = v_group.g_lead
           and s.step_number = v_group.g_step
           and s.sending_at is not null
           and ((s.status = 'failed' and s.error_code = 'stalled')
                or s.status = 'sending');
      end if;

      return next;
      continue;
    end if;

    select s.id into v_latest
      from public.scheduled_sends s
     where s.lead_id = v_group.g_lead
       and s.step_number = v_group.g_step
       and s.sending_at is not null
       and ((s.status = 'failed' and s.error_code = 'stalled')
            or (s.status = 'sending'
                and s.sending_at < now() - make_interval(mins => v_stall)))
     order by s.sending_at desc, s.id
     limit 1;

    outcome := 'recorded';

    if not p_dry_run then
      begin
        -- Repeats first: a `sending` repeat sits in the live index and would
        -- collide with the row about to become `sent`.
        update public.scheduled_sends s
           set status       = 'failed',
               error_code   = 'sent_unrecorded_repeat',
               error_detail = 'went out through Gmail but was never recorded; '
                              'a later attempt at this step is the recorded one'
         where s.lead_id = v_group.g_lead
           and s.step_number = v_group.g_step
           and s.id <> v_latest
           and s.sending_at is not null
           and ((s.status = 'failed' and s.error_code = 'stalled')
                or (s.status = 'sending'
                    and s.sending_at < now() - make_interval(mins => v_stall)));

        perform app.record_unrecorded_send(v_latest);
      exception when others then
        outcome := 'error: ' || sqlerrm;
      end;
    end if;

    return next;
  end loop;
end;
$$;

revoke all on function public.repair_stalled_sends(boolean) from public, anon;
grant execute on function public.repair_stalled_sends(boolean) to authenticated;

comment on function public.repair_stalled_sends(boolean) is
  'Records each stalled step once, from its latest attempt, and marks the other '
  'attempts as unrecorded repeats. Admin only. Dry run by default.';
