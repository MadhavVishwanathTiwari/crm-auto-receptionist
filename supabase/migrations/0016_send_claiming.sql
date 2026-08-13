-- Claiming, and the four state transitions the dispatcher is allowed to make.
--
-- All of it lives in the database rather than in the route for one reason: the
-- dispatcher is a serverless function that can be killed between any two
-- statements, and "marked sent" plus "logged a sent event" plus "stamped the
-- mailbox" has to be one atomic thing or the next run re-sends.

-- ---------------------------------------------------------------------------
-- claim_due_sends
-- ---------------------------------------------------------------------------
-- Takes a batch of due sends, respecting the daily cap of each mailbox.
--
-- Three things here are load-bearing:
--
--   1. CAPS COUNT IN THE MAILBOX'S TIMEZONE. A 20/day cap is a Gmail
--      reputation limit on the sending ACCOUNT and resets in the operator's
--      day, not the prospect's. Every other piece of scheduling math in this
--      app is prospect-local; this one is not, and collapsing the two silently
--      over-sends. cap_date is stamped here, from the mailbox's zone, and is
--      what the count reads back.
--
--   2. THE ADVISORY LOCK IS TRANSACTION-SCOPED. Cap accounting is a read
--      (count today's rows) followed by a write (claim up to the remainder),
--      and two dispatchers running that unserialized both see 19 of 20 used
--      and both claim. pg_advisory_xact_lock serializes them per mailbox and
--      releases at commit.
--
--      The brief called for a SESSION-scoped lock. That would be wrong here:
--      this function is reached over PostgREST, which runs each RPC in its own
--      transaction on a POOLED connection it then hands to the next request.
--      A session lock would outlive the request, and any error path between
--      lock and unlock would leak it permanently onto a connection that keeps
--      getting reused. The session pooler on 5432 is still required, because
--      the transaction pooler breaks prepared statements and rewrites the
--      session semantics this function's SKIP LOCKED depends on.
--
--   3. dry_run RETURNS NOTHING. Not "returns rows the dispatcher then ignores"
--      — nothing. The kill switch has to sit below the layer that could have a
--      bug in it.

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

  -- Ordered by id, not by last_send_at. Two concurrent callers must acquire
  -- the per-mailbox locks in the SAME order or they can deadlock, and
  -- last_send_at moves under them. Fairness between mailboxes is decided at
  -- plan time, where sends are dealt out round-robin, so nothing is lost.
  for v_mailbox in
    select m.id, m.timezone, m.daily_cap
      from public.mailboxes m
     where m.org_id = p_org_id
       and m.is_sendable
     order by m.id
  loop
    exit when v_remaining <= 0;

    perform pg_advisory_xact_lock(hashtextextended(v_mailbox.id::text, 0));

    -- The mailbox's own calendar day. `timezone(zone, timestamptz)` returns the
    -- wall clock in that zone.
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
         -- The grace window. A send older than this missed its slot; it is
         -- invisible here and the planner rolls it forward instead of firing
         -- it hours late, outside the window the prospect was chosen for.
         and s.scheduled_at > now() - make_interval(mins => v_settings.slot_grace_minutes)
         -- A reply, bounce or unsubscribe halts the rest of the sequence, and
         -- a human-asserted outcome ends it. Checked here as well as at plan
         -- time because the halt usually arrives after planning.
         and l.halted_at is null
         and l.terminal_outcome is null
         and l.archived_at is null
       order by s.scheduled_at
       limit v_allowed
       -- Disjoint sets for concurrent callers. `OF s` so the join to leads
       -- takes no locks.
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

comment on function public.claim_due_sends(uuid, int) is
  'Claims due sends within each mailbox''s daily cap, counted in the MAILBOX '
  'timezone. Returns nothing while org_settings.dry_run is true.';

-- ---------------------------------------------------------------------------
-- The transitions
-- ---------------------------------------------------------------------------

-- claimed -> sending. Called immediately BEFORE the Gmail request, so a
-- dispatcher that dies mid-call leaves a row that is visibly stuck rather than
-- one that looks claimable and gets sent twice.
create or replace function public.mark_send_sending(
  p_send_id     uuid,
  p_claim_token uuid
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean;
begin
  update public.scheduled_sends s
     set status = 'sending', sending_at = now()
   where s.id = p_send_id
     and s.status = 'claimed'
     -- The token proves this caller is the one that claimed it. Another
     -- dispatcher's row is not ours to send.
     and s.claim_token = p_claim_token
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

-- sending -> sent. One transaction: the row, the event, and the mailbox stamp.
--
-- The event carries the Gmail message id as dedupe_token, so the unique
-- (lead_id, type, dedupe_token) on lead_events makes a retry a no-op instead of
-- a second `sent` in the timeline. Nothing here writes leads.status; the
-- trigger on lead_events derives it.
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
  v_send public.scheduled_sends;
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

  update public.mailboxes m
     set last_send_at = now()
   where m.id = v_send.mailbox_id;

  return v_send;
end;
$$;

-- Anything that stopped the send. `attempts` was already incremented at claim,
-- so a send that keeps failing is visible without a second counter.
create or replace function public.mark_send_failed(
  p_send_id uuid,
  p_code    text,
  p_detail  text
) returns public.scheduled_sends
language plpgsql security definer set search_path = '' as $$
declare
  v_send public.scheduled_sends;
begin
  update public.scheduled_sends s
     set status = 'failed', error_code = p_code, error_detail = left(p_detail, 2000)
   where s.id = p_send_id
     and s.status in ('claimed', 'sending')
  returning s.* into v_send;

  return v_send;
end;
$$;

-- The send was correct to plan and wrong to make: suppressed between planning
-- and dispatch, a template variable with nothing behind it, a mailbox that went
-- away. Distinct from `failed`, which means we tried.
create or replace function public.mark_send_skipped(
  p_send_id uuid,
  p_reason  text
) returns public.scheduled_sends
language plpgsql security definer set search_path = '' as $$
declare
  v_send public.scheduled_sends;
begin
  update public.scheduled_sends s
     set status = 'skipped', outcome_reason = p_reason
   where s.id = p_send_id
     and s.status in ('claimed', 'sending', 'planned')
  returning s.* into v_send;

  return v_send;
end;
$$;

-- A row left in `sending` past org_settings.stall_minutes had its dispatcher
-- killed mid-flight. It is failed, never retried: we cannot know whether Gmail
-- accepted the message, and a retry that guesses wrong is a second email to a
-- prospect. The planner will consider the lead again, which is a decision a
-- human can see in the queue.
create or replace function public.reap_stalled_sends(p_org_id uuid)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_minutes int;
  v_count   int;
begin
  select stall_minutes into v_minutes
    from public.org_settings where org_id = p_org_id;
  if not found then
    return 0;
  end if;

  update public.scheduled_sends s
     set status = 'failed',
         error_code = 'stalled',
         error_detail = 'left in sending for longer than stall_minutes; '
                        'the dispatcher did not report back'
   where s.org_id = p_org_id
     and s.status = 'sending'
     and s.sending_at < now() - make_interval(mins => v_minutes);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- None of these are callable from a browser. A member who could call
-- mark_send_sent() could fabricate a `sent` event, which is exactly what the
-- lead_events insert policy exists to prevent.

revoke all on function public.claim_due_sends(uuid, int) from public, anon, authenticated;
revoke all on function public.mark_send_sending(uuid, uuid) from public, anon, authenticated;
revoke all on function public.mark_send_sent(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.mark_send_failed(uuid, text, text) from public, anon, authenticated;
revoke all on function public.mark_send_skipped(uuid, text) from public, anon, authenticated;
revoke all on function public.reap_stalled_sends(uuid) from public, anon, authenticated;

grant execute on function public.claim_due_sends(uuid, int) to service_role;
grant execute on function public.mark_send_sending(uuid, uuid) to service_role;
grant execute on function public.mark_send_sent(uuid, text, text, text, text, text) to service_role;
grant execute on function public.mark_send_failed(uuid, text, text) to service_role;
grant execute on function public.mark_send_skipped(uuid, text) to service_role;
grant execute on function public.reap_stalled_sends(uuid) to service_role;
