-- What the mailboxes sent, recorded where the app counts touches.
--
-- /write offered 141 of Ojas's leads as a first touch. 122 of them had already
-- had one, and 43 had had three: the outreach_management sheet era, sent by hand
-- out of Gmail. nextStepFor() and the planner count touches from scheduled_sends
-- rows whose status is `sent`, and none of those emails ever had one. 0027 was
-- meant to carry the sheet's timestamps across and never ran for them. And the
-- sheet is only a second-hand account anyway: each mailbox's Sent folder is the
-- record of what actually went out, and it holds the thread a follow-up has to
-- join.
--
-- Three things here:
--
--   1. record_mailbox_touches() writes one lead's real history -- the touches a
--      Sent folder shows, plus any sheet timestamp no Gmail message accounts
--      for -- as `sent` rows carrying the mailbox and the Gmail thread. Routing
--      then pins the follow-up to the account holding the conversation, and
--      dispatch-sends threads it. What the app already has is matched, not
--      duplicated, and renumbered when an earlier email turns up.
--   2. close_leads_dnc() closes leads as do_not_contact, with a suppression.
--      Two uses: the 109 rows the sheet marked `removed` (0027's close pass
--      never ran), and the seven businesses 0040's loop sent one first touch
--      five to forty-one times.
--   3. claim_due_sends() will not claim a send for a lead that had anything
--      reach Gmail in the last 20 hours. The shortest legitimate gap between
--      two touches is two business days, so no real follow-up ever waits on
--      this. It is a ceiling on the NEXT repeat bug, whatever causes it; 0040
--      closed the one we know about.
--
-- 1 and 2 are service_role only and dry run by default. They are driven by
-- scripts/reconcile-mailbox-history.mjs, which does the Gmail reading; nothing
-- in the app calls them.

-- ---------------------------------------------------------------------------
-- 1. Recording a lead's history
-- ---------------------------------------------------------------------------
-- p_touches is what one lead's Sent-folder messages say, one element per touch.
-- The script keeps one per prospect-local day, the latest: on Sep 10 the loop
-- sent some leads three different first touches in one afternoon.
--
--   { message_id, thread_id, rfc822_id, subject, sent_at, mailbox_id }
--
-- The timeline is built from three sources, in this order of authority:
--
--   existing   `sent` rows the app already has. Kept, and renumbered if an
--              earlier touch turns up before them.
--   gmail      a touch whose message id matches an existing row is that row.
--              One within 36 hours of an existing row that has NO message id
--              (0027's sheet rows; sends 0040 recorded after the fact) is the
--              same email, and lends it the ids. Anything else is new.
--   sheet      the lead's own sheet cells, parsed exactly as 0027 parses them,
--              for touches no mailbox has a message for. 36 hours of slack for
--              the same reason: the sheet was typed after the fact.
--
-- Steps are assigned by date. The sequence has four and scheduled_sends
-- refuses a fifth, so a lead with more real touches than that is reported, not
-- squeezed in: the 0040 loop leads are what this catches, and they are closed
-- rather than recorded.
--
-- Outcomes:
--   recorded / would_record   written, or would be on a real run
--   already_present           nothing to change; safe to run again
--   no_touches                nothing in either source
--   no_timezone               scheduled_sends refuses a zoneless lead's rows
--   in_flight                 a send is claimed or sending right now
--   outcome_unknown           an 0040 `stalled` row is waiting on a person
--   too_many_touches          more than four distinct touches
--   inconsistent_existing     the app's own steps disagree with their dates
--   not_found                 no such lead, or it is archived

create or replace function public.record_mailbox_touches(
  p_lead_id    uuid,
  p_touches    jsonb,
  p_sheet_zone text    default 'Asia/Kolkata',
  p_dry_run    boolean default true
) returns table (
  outcome      text,
  detail       text,
  steps_before int,
  touches      int,
  next_step    int,
  inserted     int,
  enriched     int,
  renumbered   int,
  cancelled    int
)
language plpgsql security definer set search_path = '' as $$
declare
  v_lead  public.leads;
  v_keys  text[] := array['first_touch', 'second_touch', 'third_touch', 'fourth_touch'];
  v_cell  text;
  v_at    timestamptz;
  v_t     record;
  v_row   record;
  v_match int;
  v_send  uuid;
  v_i     int;
begin
  outcome := null;
  detail := null;
  steps_before := 0;
  touches := 0;
  next_step := null;
  inserted := 0;
  enriched := 0;
  renumbered := 0;
  cancelled := 0;

  if p_touches is not null and jsonb_typeof(p_touches) <> 'array' then
    raise exception 'p_touches must be a JSON array' using errcode = '22023';
  end if;

  select * into v_lead
    from public.leads l
   where l.id = p_lead_id
     and l.archived_at is null
     for update;

  if not found then
    outcome := 'not_found';
    return next;
    return;
  end if;

  select coalesce(max(s.step_number), 0) into steps_before
    from public.scheduled_sends s
   where s.lead_id = p_lead_id
     and s.status = 'sent';

  -- A trigger refuses scheduled_sends rows for a lead with no zone, binding the
  -- service role too, so this history has nowhere to go yet. resolve-timezones
  -- runs hourly and this is re-runnable.
  if v_lead.timezone is null then
    outcome := 'no_timezone';
    return next;
    return;
  end if;

  if exists (
    select 1 from public.scheduled_sends s
     where s.lead_id = p_lead_id
       and s.status in ('claimed', 'sending')
  ) then
    outcome := 'in_flight';
    detail := 'a send is on its way right now; run again later';
    return next;
    return;
  end if;

  -- 0040: somebody has to say whether that one went out. Recording around it
  -- would be answering for them.
  if exists (
    select 1 from public.scheduled_sends s
     where s.lead_id = p_lead_id
       and s.status = 'failed'
       and s.error_code = 'stalled'
  ) then
    outcome := 'outcome_unknown';
    detail := 'an earlier send is waiting on a decision in the lead drawer';
    return next;
    return;
  end if;

  if exists (
    select 1 from public.scheduled_sends s
     where s.lead_id = p_lead_id
       and s.status = 'sent'
       and s.sent_at is null
  ) then
    outcome := 'inconsistent_existing';
    detail := 'a sent row carries no sent_at';
    return next;
    return;
  end if;

  if exists (
    select 1
      from jsonb_array_elements(coalesce(p_touches, '[]'::jsonb)) e
     where nullif(e->>'message_id', '') is null
        or nullif(e->>'sent_at', '') is null
        or nullif(e->>'mailbox_id', '') is null
        or not exists (
          select 1 from public.mailboxes m
           where m.id = (e->>'mailbox_id')::uuid
             and m.org_id = v_lead.org_id
        )
  ) then
    raise exception 'every touch needs a message_id, a sent_at and a mailbox in this lead''s org'
      using errcode = '22023';
  end if;

  -- --- the timeline --------------------------------------------------------
  create temporary table if not exists rmt_timeline (
    id         int generated always as identity,
    send_id    uuid,
    old_step   int,
    at         timestamptz not null,
    message_id text,
    thread_id  text,
    rfc822_id  text,
    subject    text,
    mailbox_id uuid,
    source     text not null,
    token      text,
    enrich     boolean not null default false,
    new_step   int
  ) on commit drop;

  truncate pg_temp.rmt_timeline;

  insert into pg_temp.rmt_timeline (
    send_id, old_step, at, message_id, thread_id, rfc822_id, subject, mailbox_id, source
  )
  select s.id, s.step_number, s.sent_at, s.provider_message_id, s.provider_thread_id,
         s.rfc822_message_id, s.rendered_subject, s.mailbox_id, 'existing'
    from public.scheduled_sends s
   where s.lead_id = p_lead_id
     and s.status = 'sent';

  for v_t in
    select nullif(e->>'message_id', '')  as message_id,
           nullif(e->>'thread_id', '')   as thread_id,
           nullif(e->>'rfc822_id', '')   as rfc822_id,
           nullif(e->>'subject', '')     as subject,
           (e->>'mailbox_id')::uuid      as mailbox_id,
           (e->>'sent_at')::timestamptz  as at
      from jsonb_array_elements(coalesce(p_touches, '[]'::jsonb)) e
     order by (e->>'sent_at')::timestamptz
  loop
    -- Already a row: the dispatcher recorded it, or an earlier run did.
    continue when exists (
      select 1 from pg_temp.rmt_timeline t where t.message_id = v_t.message_id
    );

    -- A recorded email with no Gmail id, close enough in time to be this one.
    select t.id into v_match
      from pg_temp.rmt_timeline t
     where t.send_id is not null
       and t.message_id is null
       and abs(extract(epoch from (t.at - v_t.at))) <= 36 * 3600
     order by abs(extract(epoch from (t.at - v_t.at)))
     limit 1;

    if v_match is not null then
      update pg_temp.rmt_timeline t
         set message_id = v_t.message_id,
             thread_id  = coalesce(t.thread_id, v_t.thread_id),
             rfc822_id  = coalesce(t.rfc822_id, v_t.rfc822_id),
             subject    = coalesce(t.subject, v_t.subject),
             mailbox_id = coalesce(t.mailbox_id, v_t.mailbox_id),
             enrich     = true
       where t.id = v_match;
      continue;
    end if;

    insert into pg_temp.rmt_timeline (
      at, message_id, thread_id, rfc822_id, subject, mailbox_id, source, token
    ) values (
      v_t.at, v_t.message_id, v_t.thread_id, v_t.rfc822_id, v_t.subject,
      v_t.mailbox_id, 'gmail', v_t.message_id
    );
  end loop;

  -- The sheet, for touches no mailbox has a message for. Only a sheet-sourced
  -- lead has these keys; detectShape and 0027 recognise it the same way.
  if p_sheet_zone is not null
     and jsonb_exists(coalesce(v_lead.raw, '{}'::jsonb), 'first_touch') then
    for v_i in 1..4 loop
      v_cell := btrim(coalesce(v_lead.raw->>v_keys[v_i], ''));
      continue when v_cell = '';

      v_at := app.parse_sheet_timestamp(v_cell, p_sheet_zone);
      if v_at is null then
        detail := concat_ws('; ', detail, format('%s = %L could not be read', v_keys[v_i], v_cell));
        continue;
      end if;

      continue when exists (
        select 1 from pg_temp.rmt_timeline t
         where abs(extract(epoch from (t.at - v_at))) <= 36 * 3600
      );

      -- Same token 0027 would have used, so the two can never both record it.
      insert into pg_temp.rmt_timeline (at, source, token)
      values (v_at, 'sheet', 'sheet:' || v_keys[v_i]);
    end loop;
  end if;

  select count(*) into touches from pg_temp.rmt_timeline;

  if touches = 0 then
    outcome := 'no_touches';
    return next;
    return;
  end if;

  if touches > 4 then
    outcome := 'too_many_touches';
    detail := concat_ws('; ', detail, format('%s distinct touches; the sequence has four', touches));
    return next;
    return;
  end if;

  update pg_temp.rmt_timeline t
     set new_step = r.rn
    from (
      select x.id,
             row_number() over (order by x.at, coalesce(x.message_id, ''), x.id) as rn
        from pg_temp.rmt_timeline x
    ) r
   where r.id = t.id;

  -- New touches only ever slot in around the app's own rows, so those keep
  -- their relative order. If they do not, the existing numbering disagrees
  -- with the calendar, and that is for a person to look at.
  if exists (
    select 1
      from pg_temp.rmt_timeline a
      join pg_temp.rmt_timeline b
        on a.send_id is not null
       and b.send_id is not null
       and a.old_step < b.old_step
     where a.new_step > b.new_step
  ) then
    outcome := 'inconsistent_existing';
    detail := concat_ws('; ', detail, 'the recorded steps are out of date order');
    return next;
    return;
  end if;

  next_step := case when touches >= 4 then null else touches + 1 end;

  select count(*) filter (where t.send_id is null),
         count(*) filter (where t.enrich),
         count(*) filter (where t.send_id is not null and t.new_step <> t.old_step)
    into inserted, enriched, renumbered
    from pg_temp.rmt_timeline t;

  select count(*) into cancelled
    from public.scheduled_sends s
   where s.lead_id = p_lead_id
     and s.status in ('planned', 'blocked')
     and s.step_number <= touches;

  if inserted = 0 and enriched = 0 and renumbered = 0 and cancelled = 0 then
    outcome := 'already_present';
    return next;
    return;
  end if;

  if p_dry_run then
    outcome := 'would_record';
    return next;
    return;
  end if;

  -- --- write ---------------------------------------------------------------

  -- A booked step that has in fact already gone out. Cancelled first, because
  -- it sits in scheduled_sends_lead_step_live on a step about to be recorded.
  -- The words stay on the row, so a hand-written one is not lost.
  update public.scheduled_sends s
     set status = 'cancelled',
         outcome_reason = 'step ' || s.step_number
                          || ' had already gone out; recorded from the mailbox history'
   where s.lead_id = p_lead_id
     and s.status in ('planned', 'blocked')
     and s.step_number <= touches;

  -- Renumbering without two live rows ever sharing a step. Order is preserved,
  -- so moving the rows that go up highest-first, then the rows that go down
  -- lowest-first, only ever lands a row on a step something has already left.
  for v_row in
    select t.send_id, t.new_step
      from pg_temp.rmt_timeline t
     where t.send_id is not null and t.new_step > t.old_step
     order by t.new_step desc
  loop
    update public.scheduled_sends s
       set step_number = v_row.new_step,
           touch_kind  = (case when v_row.new_step = 1 then 'first' else 'followup' end)::public.touch_kind
     where s.id = v_row.send_id;
  end loop;

  for v_row in
    select t.send_id, t.new_step
      from pg_temp.rmt_timeline t
     where t.send_id is not null and t.new_step < t.old_step
     order by t.new_step asc
  loop
    update public.scheduled_sends s
       set step_number = v_row.new_step,
           touch_kind  = (case when v_row.new_step = 1 then 'first' else 'followup' end)::public.touch_kind
     where s.id = v_row.send_id;
  end loop;

  -- Ids for rows that had none. Never overwrites a value already there.
  update public.scheduled_sends s
     set mailbox_id          = coalesce(s.mailbox_id, t.mailbox_id),
         provider_message_id = coalesce(s.provider_message_id, t.message_id),
         provider_thread_id  = coalesce(s.provider_thread_id, t.thread_id),
         rfc822_message_id   = coalesce(s.rfc822_message_id, t.rfc822_id),
         rendered_subject    = coalesce(s.rendered_subject, t.subject)
    from pg_temp.rmt_timeline t
   where t.enrich
     and t.send_id = s.id;

  for v_row in
    select * from pg_temp.rmt_timeline t where t.send_id is null order by t.new_step
  loop
    insert into public.scheduled_sends (
      org_id, lead_id,
      -- The mailbox is known and is what pins the follow-up to this thread.
      -- template_id stays NULL: nothing says which copy it was, and that NULL
      -- is also what tells the planner a person owns this sequence.
      mailbox_id, template_id,
      step_number, touch_kind, status,
      scheduled_at, scheduled_local, prospect_timezone, sent_at,
      -- NULL: an email from last month must not consume today's cap.
      cap_date,
      rendered_subject, provider_message_id, provider_thread_id, rfc822_message_id,
      outcome_reason
    ) values (
      v_lead.org_id, p_lead_id,
      v_row.mailbox_id, null,
      v_row.new_step,
      (case when v_row.new_step = 1 then 'first' else 'followup' end)::public.touch_kind,
      'sent',
      v_row.at, (v_row.at at time zone v_lead.timezone), v_lead.timezone, v_row.at,
      null,
      v_row.subject, v_row.message_id, v_row.thread_id, v_row.rfc822_id,
      case when v_row.source = 'sheet'
           then 'recorded from the outreach sheet; no Sent-folder message matches it'
           else 'recorded from the mailbox''s Sent folder'
      end
    )
    returning id into v_send;

    -- The Gmail id as dedupe_token, the same token mark_send_sent() uses, so a
    -- send the dispatcher recorded and the Sent folder lists is one event.
    insert into public.lead_events (
      org_id, lead_id, type, actor_id, occurred_at, scheduled_send_id, dedupe_token, payload
    ) values (
      v_lead.org_id, p_lead_id, 'sent', null, v_row.at, v_send, v_row.token,
      jsonb_build_object(
        'source',      case when v_row.source = 'sheet' then 'sheet_import' else 'mailbox_history' end,
        'step_number', v_row.new_step,
        'mailbox_id',  v_row.mailbox_id,
        'subject',     v_row.subject,
        'thread_id',   v_row.thread_id,
        'recorded_after_the_fact', true
      )
    )
    on conflict (lead_id, type, dedupe_token) do nothing;
  end loop;

  outcome := 'recorded';
  return next;
end;
$$;

revoke all on function public.record_mailbox_touches(uuid, jsonb, text, boolean)
  from public, anon, authenticated;
grant execute on function public.record_mailbox_touches(uuid, jsonb, text, boolean)
  to service_role;

comment on function public.record_mailbox_touches(uuid, jsonb, text, boolean) is
  'Records one lead''s real touch history from its Sent-folder messages and '
  'sheet cells as sent rows with mailbox and thread, matching and renumbering '
  'what the app already has. Service role only. Dry run by default.';

-- ---------------------------------------------------------------------------
-- 2. Closing leads nobody should contact again
-- ---------------------------------------------------------------------------
-- The same writes as 0027's close_removed_lead_one(), with the reason as a
-- parameter: terminal_outcome under the guard bypass, a `closed` event, and a
-- manual_dnc suppression on the work email, which is what survives a re-import.
-- The token keeps it idempotent, and `sheet:removed` is 0027's own token, so a
-- lead that pass already closed is not closed twice.

create or replace function app.close_dnc_one(
  p_lead_id uuid,
  p_token   text,
  p_note    text,
  p_dry_run boolean,
  out outcome text
)
language plpgsql set search_path = '' as $$
declare
  v_lead     public.leads;
  v_previous text;
begin
  select * into v_lead
    from public.leads l
   where l.id = p_lead_id
     and l.archived_at is null
     for update;

  if not found then
    outcome := 'not_found';
    return;
  end if;

  if v_lead.terminal_outcome is not null then
    outcome := 'already_closed';
    return;
  end if;

  if p_dry_run then
    outcome := 'closed';
    return;
  end if;

  v_previous := coalesce(current_setting('app.bypass_lead_guard', true), 'off');
  perform set_config('app.bypass_lead_guard', 'on', true);

  update public.leads l
     set terminal_outcome = 'do_not_contact'
   where l.id = p_lead_id;

  perform set_config('app.bypass_lead_guard', v_previous, true);

  insert into public.lead_events (org_id, lead_id, type, actor_id, dedupe_token, payload)
  values (
    v_lead.org_id, p_lead_id, 'closed', null, p_token,
    jsonb_build_object('outcome', 'do_not_contact', 'note', p_note, 'source', 'reconcile')
  )
  on conflict (lead_id, type, dedupe_token) do nothing;

  -- An existence check rather than ON CONFLICT: suppressions_email_key is a
  -- partial unique index, the arbiter trap 0027 records.
  if v_lead.work_email_norm is not null
     and not exists (
       select 1 from public.suppressions s
        where s.org_id = v_lead.org_id
          and s.email_norm = v_lead.work_email_norm
     )
  then
    insert into public.suppressions (org_id, email_norm, reason, lead_id, notes, created_by)
    values (v_lead.org_id, v_lead.work_email_norm, 'manual_dnc', p_lead_id, p_note, null);
  end if;

  outcome := 'closed';
end;
$$;

revoke all on function app.close_dnc_one(uuid, text, text, boolean) from public;

create or replace function public.close_leads_dnc(
  p_lead_ids uuid[],
  p_token    text,
  p_note     text,
  p_dry_run  boolean default true
) returns table (
  lead_id uuid,
  company text,
  outcome text
)
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_token is null or btrim(p_token) = '' then
    raise exception 'p_token is required: it is what makes a second run a no-op'
      using errcode = '22023';
  end if;
  if p_note is null or btrim(p_note) = '' then
    raise exception 'p_note is required: it is the only record of why'
      using errcode = '22023';
  end if;

  foreach v_id in array coalesce(p_lead_ids, '{}'::uuid[]) loop
    lead_id := v_id;
    company := (select l.company_name from public.leads l where l.id = v_id);

    -- One subtransaction per lead, so one surprise reports rather than undoes.
    begin
      outcome := (select c.outcome from app.close_dnc_one(v_id, p_token, p_note, p_dry_run) c);
    exception when others then
      outcome := 'error: ' || sqlerrm;
    end;

    return next;
  end loop;
end;
$$;

revoke all on function public.close_leads_dnc(uuid[], text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.close_leads_dnc(uuid[], text, text, boolean)
  to service_role;

comment on function public.close_leads_dnc(uuid[], text, text, boolean) is
  'Closes each lead as do_not_contact with a closed event and a manual_dnc '
  'suppression on its work email. Service role only. Dry run by default.';

-- ---------------------------------------------------------------------------
-- 3. Never two emails to one lead inside 20 hours
-- ---------------------------------------------------------------------------
-- Restated in full from 0041 with one condition added; see 0016, 0040 and 0041
-- for the reasoning behind the rest, all of which still holds.
--
-- sending_at is when the dispatcher reached Gmail; sent_at covers history
-- recorded from a Sent folder, which never had a sending_at. Any status counts,
-- `failed` included: a stalled or repeat row reached Gmail too.

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
         -- 0042: nothing reached Gmail for this lead in the last 20 hours.
         and not exists (
           select 1 from public.scheduled_sends y
            where y.lead_id = s.lead_id
              and y.id <> s.id
              and greatest(y.sending_at, y.sent_at) > now() - interval '20 hours'
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
