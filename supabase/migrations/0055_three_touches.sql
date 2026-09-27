-- The sequence is three touches, not four.
--
-- T1, the demo link at T2, and the close at T3. The old T3 ("still live") was
-- a second nudge about the same demo, and T4 was the email that actually asked
-- for a decision. Cutting a touch therefore means cutting the nudge and moving
-- the close up, not deleting the last row: a sequence that ends on "it is still
-- up" never asks the question.
--
-- Three touches instead of four is a quarter less mailbox per lead, so the same
-- 20/day cap carries about a third more leads through a whole sequence.
--
-- What this migration does NOT do, deliberately:
--
-- * It does not narrow scheduled_sends_step_range to 1..3. Six T4s have already
--   gone out, and a Sent folder showing four emails to a lead is history the
--   reconciler (0042) still has to be able to record. A step-4 row may exist;
--   a step-4 row that could still be DISPATCHED may not be created. That is the
--   trigger below, and it binds the service role like every other guard on
--   this table, because every writer of scheduled_sends is a machine.
--
-- * It does not cancel the T4s already booked. On the day this ran there were
--   eleven, all templated closing emails for 1 and 2 Oct, to leads that had the
--   old "still live" T3 and no close yet. The close is exactly what the new
--   sequence ends on, so they are left to go out. The trigger fires on INSERT
--   and on a change of step_number, so their planned -> claimed -> sending ->
--   sent walk passes untouched. The planner cancels one that misses its slot
--   rather than re-timing it (plan-sends, `step > MAX_STEP`).
--
-- * It does not restate queue_composed_send(), whose own check still reads
--   "between 1 and 4". /write never offers a step past MAX_STEP, and a direct
--   RPC call asking for step 4 is refused here at the insert, with a sentence.

-- --- templates -----------------------------------------------------------

-- The step-3 slot is vacated wherever an active T4 is about to move into it.
-- The partial unique indexes from 0014 allow one active template per
-- (org, step, angle), so this has to come first.
update public.templates t3
   set is_active = false
 where t3.step_number = 3
   and t3.is_active
   and exists (
     select 1
       from public.templates t4
      where t4.org_id = t3.org_id
        and t4.step_number = 4
        and t4.is_active
        and t4.angle_type is not distinct from t3.angle_type
   );

-- A copy rather than an UPDATE of the T4 row in place, so the six sent T4s
-- and the eleven booked ones still point at a template whose step matches
-- theirs. The dispatcher loads templates by id and never asks is_active, so
-- retiring the originals below does not strand the booked ones.
--
-- requires_demo is false because the close quotes no demo: neither seeded
-- closing email uses {{demo_url}} (tests/unit/seededTemplates.test.ts), and a
-- lead whose demo never got built should still get asked.
--
-- Inactive T4s are copied as inactive step-3 drafts. On a fresh stack that is
-- the whole seed, which is how db:reset ends up with the same shape as cloud.
insert into public.templates
  (org_id, name, step_number, angle_type, subject, body, requires_demo, is_active, created_by)
select t4.org_id,
       regexp_replace(t4.name, '^T4\M', 'T3'),
       3,
       t4.angle_type,
       t4.subject,
       t4.body,
       false,
       t4.is_active,
       t4.created_by
  from public.templates t4
 where t4.step_number = 4;

update public.templates set is_active = false where step_number = 4 and is_active;

-- An inactive step-4 template is history (17 sends point at the two seeded
-- ones). An active one is a touch nothing will ever book, so it is refused
-- rather than left looking live on /templates.
alter table public.templates
  add constraint templates_live_steps check (not is_active or step_number <= 3);

-- --- scheduled_sends -----------------------------------------------------

create or replace function app.scheduled_sends_three_touches()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.step_number <= 3 then
    return new;
  end if;

  -- A record of an email that already left (0027's sheet backfill, 0042's
  -- Sent-folder reconcile, including its renumbering) is not a booking.
  if new.status = 'sent' then
    return new;
  end if;

  raise exception
    'the sequence is three touches, so step % cannot be booked for lead %',
    new.step_number, new.lead_id
    using errcode = '23514',
          hint = 'A fourth email to this lead is a conversation; write it from Gmail.';
end;
$$;

-- `update of step_number` only: a booked T4 from before this migration changes
-- status on its way out and must not be refused for it.
create trigger scheduled_sends_three_touches
  before insert or update of step_number on public.scheduled_sends
  for each row execute function app.scheduled_sends_three_touches();

-- Firing a trigger does not check EXECUTE; nothing calls this directly.
revoke all on function app.scheduled_sends_three_touches() from public, anon, authenticated;

-- --- the reports ---------------------------------------------------------

-- Both history recorders report `next_step`, the touch a lead is due next, and
-- both said 4 after three touches. /write and the planner now say the sequence
-- is finished for that lead, so a dry run on /import would have promised a
-- touch nothing will ever book. Restated verbatim from 0027 and 0042 with only
-- that threshold changed; `create or replace` keeps their grants.

create or replace function public.backfill_sheet_touch_history(
  p_zone             text    default 'Asia/Kolkata',
  p_dry_run          boolean default true,
  p_close_removed    boolean default true,
  p_suppress_domain  boolean default false
) returns table (
  lead_id      uuid,
  company      text,
  sheet_status text,
  touches      int,
  next_step    int,
  outcome      text,
  detail       text
)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_row record;
  v_one record;
begin
  if v_org is null then
    raise exception 'not a member of any org' using errcode = '42501';
  end if;
  if not app.is_admin() then
    raise exception
      'only an admin may backfill outreach history for the whole org'
      using errcode = '42501';
  end if;
  if p_zone is null or btrim(p_zone) = '' then
    raise exception 'p_zone is required: the sheet timestamps carry no offset'
      using errcode = '22023';
  end if;
  -- A bad zone name would otherwise silently become a parse failure on every
  -- single row, and the pass would report `unparseable` 262 times for a reason
  -- that has nothing to do with the data.
  begin
    perform now() at time zone p_zone;
  exception when others then
    -- RAISE understands `%` and nothing else; %L is a format() specifier and
    -- would print the value with a stray L after it.
    raise exception '% is not a recognised time zone', p_zone using errcode = '22023';
  end;

  for v_row in
    select l.id, l.company_name,
           nullif(btrim(coalesce(l.raw->>'status', '')), '') as sheet_status
      from public.leads l
     where l.org_id = v_org
       and l.archived_at is null
       -- The marker of a sheet-sourced row. detectShape uses the same three
       -- columns to recognise the legacy shape at import time.
       and jsonb_exists(l.raw, 'first_touch')
     order by l.created_at
  loop
    lead_id      := v_row.id;
    company      := v_row.company_name;
    sheet_status := v_row.sheet_status;
    touches      := 0;
    next_step    := null;
    outcome      := null;
    detail       := null;

    -- One subtransaction per lead. Both writes for a lead land together or
    -- neither does -- events without sends is the restart-at-T1 bug -- while a
    -- surprise on one row still leaves the other 332 processed.
    begin
      select * into v_one
        from app.record_sheet_touches_one(v_org, v_row.id, p_zone, p_dry_run);

      outcome := v_one.outcome;
      detail  := v_one.detail;
      touches := v_one.touches;

      if v_one.outcome in ('recorded', 'already_present') and v_one.touches > 0 then
        -- 3 is MAX_STEP since 0055. A lead that had all three is finished,
        -- and the planner drops it on `if (step > MAX_STEP)`.
        next_step := case when v_one.touches >= 3 then null else v_one.touches + 1 end;
      end if;

      -- Removal is handled whatever the touch outcome was, including
      -- `no_timezone`: closing a lead needs no zone, and 104 of the 109 removed
      -- rows have no touches to record in the first place.
      if p_close_removed and v_row.sheet_status = 'removed' then
        declare
          v_closed text;
        begin
          select c.outcome into v_closed
            from app.close_removed_lead_one(v_org, v_row.id, p_suppress_domain, p_dry_run) c;

          -- Do-not-contact is the headline for this lead; the touch outcome
          -- becomes a note beside it. next_step is cleared because a closed
          -- lead resumes at no step at all.
          next_step := null;
          detail    := nullif(concat_ws(' / ', outcome, detail), '');
          outcome   := case when v_closed = 'already_closed'
                            then 'already_closed' else 'do_not_contact' end;
        end;
      end if;

    exception when others then
      outcome := 'error';
      detail  := sqlerrm;
      next_step := null;
    end;

    return next;
  end loop;
end;
$$;

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

  -- 3 is MAX_STEP since 0055. Four touches is still recordable history.
  next_step := case when touches >= 3 then null else touches + 1 end;

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
