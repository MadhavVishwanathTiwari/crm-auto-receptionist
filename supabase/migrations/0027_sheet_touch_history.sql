-- Carrying outreach history across from the Google Sheet.
--
-- The sibling of 0025. That migration recovered `lead_owner`; this one recovers
-- what was actually sent. The sheet records up to four touch timestamps per row
-- and the importer kept them only inside `leads.raw`, so the app believes 333
-- already-worked leads have never been contacted.
--
-- Nothing auto-sends today, and two separate gates say so: the planner requires
-- an `audited` or `queued` event, and every one of those 333 rows is
-- `is_qualified = false` because the sheet has no rating column. But both gates
-- are one enrichment pass or one button away from opening, and the moment they
-- do, a lead that already received three emails starts again at T1.
--
-- ---------------------------------------------------------------------------
-- Why this writes TWO things per touch
-- ---------------------------------------------------------------------------
-- `lead_events` alone is not enough, and this is the whole trap in the task.
--
-- A `sent` event makes app.lead_status_from_events derive `sent`, which is what
-- puts the lead back in the planner's SENDABLE_STATUSES. But the planner does
-- not ask the event log which touch comes next. Both it and /write count from
-- `scheduled_sends` rows whose status is 'sent':
--
--   app/api/cron/plan-sends/route.ts   step = (lastSent?.step_number ?? 0) + 1
--   lib/write/context.ts nextStepFor() step = (lastSent?.step_number ?? 0) + 1
--
-- So events alone would produce the worst possible state: status `sent`, which
-- opens the gate, over a step count of zero, which restarts at T1. Writing only
-- the sends would be safe but would leave the timeline blank. Both, or neither
-- -- which is why each lead is processed in its own subtransaction below.
--
-- ---------------------------------------------------------------------------
-- What the data actually says
-- ---------------------------------------------------------------------------
-- Measured against the cloud project before this was written:
--
--   * `fourth_touch` exists as a column and is empty on all 333 rows.
--   * Touches are contiguous. No row has a second touch without a first.
--   * The `status` column DISAGREES with the timestamps on 27 rows. 21 say
--     `first_touch` while carrying three; three say `second_touch` while
--     carrying three; one says `pending` while carrying one; one says
--     `first_touch` while carrying none.
--
--     The timestamps win, always. They are the record of what left; `status` is
--     a label somebody maintained by hand. Resuming from `status` would send
--     those 21 leads a second T2 and a second T3.
--
--   * 121 timestamps have a first component above 12, and none has a second
--     component above 12. Day-first is not an assumption here, it is proved by
--     the data.
--   * Six distinct string shapes, including three dirty ones -- `31/ 07/26
--     13:47`, `11/08/26/ 21:40`, and a handful carrying seconds. A parser that
--     only handled the common shape would silently drop a touch and restart
--     that lead one step early, so the normalizer below covers all six.

-- ---------------------------------------------------------------------------
-- Parsing a sheet timestamp
-- ---------------------------------------------------------------------------
-- Returns NULL rather than raising, so one malformed cell is a reported row in
-- the migration's output instead of a stop in the middle of a bulk pass.
--
-- The zone is a parameter with no default, because inventing one is exactly
-- what non-negotiable 6 forbids. The caller supplies it, and the caller's
-- default is documented where it is chosen.

create or replace function app.parse_sheet_timestamp(p_raw text, p_zone text)
-- STABLE, not IMMUTABLE: `at time zone <name>` reads the tz database, and that
-- can change under a running server.
returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  v_text  text;
  v_parts text[];
  v_day   int;
  v_month int;
  v_year  int;
  v_hour  int;
  v_min   int;
  v_sec   int;
begin
  if p_raw is null or btrim(p_raw) = '' or p_zone is null then
    return null;
  end if;

  -- The dirty shapes, normalized away before matching. Order matters: closing
  -- up the spaces around separators turns `11/08/26/ 21:40` into
  -- `11/08/26/21:40`, so the stray separator has to be dealt with after that,
  -- not before, and it is identified by the time sitting directly behind it.
  v_text := btrim(p_raw);
  v_text := regexp_replace(v_text, '\s+', ' ', 'g');          -- doubled spaces
  v_text := regexp_replace(v_text, '\s*/\s*', '/', 'g');      -- `31/ 07/26`
  v_text := regexp_replace(v_text, '/([0-9]{1,2}:[0-9]{2})', ' \1');  -- `26/ 21:40`

  -- Day first. Not month first: see the header.
  v_parts := regexp_match(
    v_text,
    '^([0-9]{1,2})/([0-9]{1,2})/([0-9]{2}|[0-9]{4}) ([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?$'
  );

  if v_parts is null then
    return null;
  end if;

  v_day   := v_parts[1]::int;
  v_month := v_parts[2]::int;
  v_year  := v_parts[3]::int;
  v_hour  := v_parts[4]::int;
  v_min   := v_parts[5]::int;
  v_sec   := coalesce(v_parts[6]::int, 0);

  -- A two-digit year in a sheet started in 2026 is this century. Spelling it
  -- out rather than relying on Postgres's own pivot, which is a different rule.
  if v_year < 100 then
    v_year := 2000 + v_year;
  end if;

  if v_month < 1 or v_month > 12
     or v_day < 1 or v_day > 31
     or v_hour > 23 or v_min > 59 or v_sec > 59 then
    return null;
  end if;

  -- make_timestamp raises on a day that does not exist in its month (31 Feb),
  -- which is a malformed cell like any other and must not abort the pass.
  begin
    return make_timestamp(v_year, v_month, v_day, v_hour, v_min, v_sec)
             at time zone p_zone;
  exception when others then
    return null;
  end;
end;
$$;

comment on function app.parse_sheet_timestamp(text, text) is
  'DD/MM/YY[YY] HH:MM[:SS] as written by the outreach_management sheet, read '
  'day-first and interpreted in the zone supplied. NULL on anything it cannot '
  'read, so a bad cell is reported rather than guessed at.';

revoke all on function app.parse_sheet_timestamp(text, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Making room for a send that already happened
-- ---------------------------------------------------------------------------
-- 0023 requires every new scheduled_sends row to carry either a template or a
-- written body, because a row with no words is a row the dispatcher cannot
-- send. That is exactly right for anything it will ever pick up, and exactly
-- wrong for the rows written below: the sheet recorded THAT an email went out
-- and never recorded what it said. There is no template to name, and inventing
-- a body would put words in an operator's mouth and hand them to the dispatcher
-- as though they were real -- composed_body is dispatched verbatim.
--
-- The exemption is deliberately narrow: a row that arrives already `sent`, and
-- carries the instant it went out. That is a record of the past rather than an
-- instruction about the future, and claim_due_sends() only ever takes
-- `planned`, so nothing exempted here can reach Gmail. Requiring sent_at as
-- well as the status is what stops `status = 'sent'` becoming a way to insert a
-- wordless row that some later change might treat as live.
--
-- Every row that could still be dispatched is bound exactly as it was.

create or replace function app.scheduled_sends_require_content()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- History, not a plan. See 0027.
  if new.status = 'sent' and new.sent_at is not null then
    return new;
  end if;

  if new.template_id is null and new.composed_body is null then
    raise exception
      'a scheduled send needs either a template or a written body'
      using errcode = '23514',
            hint = 'Template sends come from the planner. Written ones come '
                   'from queue_composed_send().';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- One lead's history
-- ---------------------------------------------------------------------------
-- Returns an outcome string rather than raising, for the same reason 0025's
-- assign_lead_owner_one does: a bulk pass wants a tally at the end, not a stop
-- at the first surprise.
--
-- Outcomes:
--   recorded        touches written (detail carries how many)
--   already_present every touch already had a live send at its step
--   no_touches      the sheet records none
--   no_timezone     lead has no IANA zone, so no send row may exist for it yet
--   unparseable     a touch cell that could not be read
--   gap             a later touch filled while an earlier one is blank
--   out_of_order    touch timestamps that do not increase
--   step_conflict   a live send already occupies a step we would have to write
--   not_found       no such lead in this org

create or replace function app.record_sheet_touches_one(
  p_org     uuid,
  p_lead_id uuid,
  p_zone    text,
  p_dry_run boolean,
  out outcome text,
  out detail  text,
  out touches int
)
language plpgsql security definer set search_path = '' as $$
declare
  v_lead    public.leads;
  v_keys    text[] := array['first_touch', 'second_touch', 'third_touch', 'fourth_touch'];
  v_at      timestamptz[] := '{}';
  v_cell    text;
  v_parsed  timestamptz;
  v_step    int;
  v_blank   boolean := false;
  v_send_id uuid;
begin
  touches := 0;

  select * into v_lead
    from public.leads l
   where l.id = p_lead_id and l.org_id = p_org and l.archived_at is null;

  if not found then
    outcome := 'not_found';
    return;
  end if;

  -- --- read the four cells -------------------------------------------------
  for v_step in 1..4 loop
    v_cell := btrim(coalesce(v_lead.raw->>v_keys[v_step], ''));

    if v_cell = '' then
      v_blank := true;
      continue;
    end if;

    -- A filled cell after a blank one. The sequence has no way to express
    -- "touch three but not touch two", and quietly compressing them would
    -- misreport which step this lead is on.
    if v_blank then
      outcome := 'gap';
      detail  := format('%s is filled but an earlier touch is not', v_keys[v_step]);
      return;
    end if;

    v_parsed := app.parse_sheet_timestamp(v_cell, p_zone);
    if v_parsed is null then
      outcome := 'unparseable';
      detail  := format('%s = %L', v_keys[v_step], v_cell);
      return;
    end if;

    -- Time only moves forward. A later touch dated before an earlier one means
    -- the cell is wrong, and the cadence arithmetic downstream counts business
    -- days from whichever is last.
    if array_length(v_at, 1) is not null and v_parsed < v_at[array_length(v_at, 1)] then
      outcome := 'out_of_order';
      detail  := format('%s (%s) precedes the touch before it', v_keys[v_step], v_cell);
      return;
    end if;

    v_at := v_at || v_parsed;
  end loop;

  touches := coalesce(array_length(v_at, 1), 0);

  if touches = 0 then
    outcome := 'no_touches';
    -- Worth naming, because the sheet's own status column claims otherwise on
    -- one row and the operator should look at it rather than trust this pass.
    if btrim(coalesce(v_lead.raw->>'status', '')) not in ('', 'pending', 'removed') then
      detail := format('sheet status is %L but no touch is timestamped',
                       v_lead.raw->>'status');
    end if;
    return;
  end if;

  -- --- the timezone gate ---------------------------------------------------
  -- scheduled_sends.prospect_timezone is NOT NULL and a trigger refuses any row
  -- whose lead has no zone -- deliberately, and it binds the service role too.
  -- So a zoneless lead cannot get its send rows, and it must therefore not get
  -- its events either: status `sent` over a step count of zero is precisely the
  -- restart-at-T1 bug this migration exists to prevent.
  --
  -- Nothing is lost by waiting. resolve-timezones runs hourly and this pass is
  -- re-runnable, so these leads are picked up on the next run after they are
  -- zoned.
  if v_lead.timezone is null then
    outcome := 'no_timezone';
    detail  := format('%s touch(es) held until a zone is resolved', touches);
    return;
  end if;

  -- --- refuse to write over a live send ------------------------------------
  -- scheduled_sends_lead_step_live would raise 23505 anyway. Checking first
  -- turns that into a reported row, and covers the case where only SOME of the
  -- steps collide.
  if exists (
    select 1 from public.scheduled_sends s
     where s.lead_id = p_lead_id
       and s.step_number <= touches
       and s.status in ('planned', 'blocked', 'claimed', 'sending')
  ) then
    outcome := 'step_conflict';
    detail  := 'a send is already booked or in flight at one of these steps';
    return;
  end if;

  -- Already done, on a previous run. Both writes are keyed so this is cheap to
  -- ask and safe to press twice.
  if (select count(*) from public.scheduled_sends s
       where s.lead_id = p_lead_id
         and s.step_number <= touches
         and s.status = 'sent') = touches then
    outcome := 'already_present';
    return;
  end if;

  if p_dry_run then
    outcome := 'recorded';
    detail  := format('%s touch(es), last %s', touches, v_at[touches]);
    return;
  end if;

  -- --- write ---------------------------------------------------------------
  for v_step in 1..touches loop
    -- Skip a step already recorded, so a partially-applied run completes rather
    -- than colliding with itself.
    select s.id into v_send_id
      from public.scheduled_sends s
     where s.lead_id = p_lead_id
       and s.step_number = v_step
       and s.status = 'sent';

    if not found then
      insert into public.scheduled_sends (
        org_id, lead_id,
        -- mailbox_id and template_id stay NULL. The sheet does not record which
        -- account sent it or what copy it used, and inventing either would put
        -- a false answer where the app expects a true one. NULL mailbox_id also
        -- keeps these rows out of buildCapacity() and out of the cap count in
        -- claim_due_sends(), which is correct: a send from months ago must not
        -- consume today's allowance.
        mailbox_id, template_id,
        step_number, touch_kind, status,
        scheduled_at, scheduled_local, prospect_timezone,
        sent_at,
        -- cap_date stays NULL for the same reason.
        cap_date,
        -- rendered_subject/body stay NULL. "What did we say to this person" is
        -- not recoverable from the sheet, and an empty string would claim it is.
        rendered_subject, rendered_body
      ) values (
        p_org, p_lead_id,
        null, null,
        v_step,
        case when v_step = 1 then 'first' else 'followup' end::public.touch_kind,
        'sent',
        v_at[v_step],
        (v_at[v_step] at time zone v_lead.timezone),
        v_lead.timezone,
        v_at[v_step],
        null,
        null, null
      )
      returning id into v_send_id;
    end if;

    -- The event. dedupe_token is the sheet column it came from, which is what
    -- makes the whole pass idempotent: lead_events carries
    -- unique (lead_id, type, dedupe_token), so a second run inserts nothing.
    --
    -- actor_id is NULL, matching how the dispatcher writes its own `sent` event
    -- in 0016. The sheet names a lead OWNER, not a sender, and 0025 already
    -- credits that person on the `claimed` event where it belongs.
    insert into public.lead_events (
      org_id, lead_id, type, actor_id, occurred_at,
      scheduled_send_id, dedupe_token, payload
    ) values (
      p_org, p_lead_id, 'sent', null, v_at[v_step],
      v_send_id,
      'sheet:' || v_keys[v_step],
      jsonb_build_object(
        'source', 'sheet_import',
        'step_number', v_step,
        'sheet_column', v_keys[v_step],
        'sheet_value', btrim(v_lead.raw->>v_keys[v_step]),
        'sheet_status', nullif(btrim(coalesce(v_lead.raw->>'status', '')), ''),
        'interpreted_in', p_zone,
        'backfilled_by', auth.uid()
      )
    )
    on conflict (lead_id, type, dedupe_token) do nothing;
  end loop;

  outcome := 'recorded';
  detail  := format('%s touch(es), last %s', touches, v_at[touches]);
end;
$$;

revoke all on function app.record_sheet_touches_one(uuid, uuid, text, boolean)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- `removed` means do not contact
-- ---------------------------------------------------------------------------
-- 109 rows carry it and the sheet does not say why. Two things are written, and
-- they are not redundant:
--
--   * a `closed` event with terminal_outcome `do_not_contact`, which is how a
--     human-asserted outcome is recorded everywhere else in this schema (0004).
--     It settles THIS lead: the planner filters on terminal_outcome, and
--     app.lead_status_from_events lets it beat any later event.
--
--   * a suppression on the work email, which survives what the lead row cannot.
--     Re-import the same business tomorrow and it arrives as a NEW lead with no
--     terminal outcome; the suppression is the only thing that still stops it.
--     The dispatcher also re-checks suppressions at send time rather than at
--     plan time, so this closes the last gap before Gmail.
--
-- reason `manual_dnc`, not `unsubscribed` or `complaint`. Those assert a fact
-- about what the prospect did, and all we actually know is that an operator
-- took the row out.
--
-- Email, not domain, by default. Domain suppression is the bigger hammer -- one
-- "remove us" covering every contact at that company -- and `removed` may just
-- as easily have meant "wrong contact" or "bad fit". p_suppress_domain is there
-- for the operator who knows it meant the company, and it is off by default
-- because the wrong answer silently kills 100 domains' worth of future leads.

create or replace function app.close_removed_lead_one(
  p_org      uuid,
  p_lead_id  uuid,
  p_domain   boolean,
  p_dry_run  boolean,
  out outcome text
)
language plpgsql security definer set search_path = '' as $$
declare
  v_lead public.leads;
begin
  select * into v_lead
    from public.leads l
   where l.id = p_lead_id and l.org_id = p_org and l.archived_at is null;

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

  perform set_config('app.bypass_lead_guard', 'on', true);

  update public.leads l
     set terminal_outcome = 'do_not_contact'
   where l.id = p_lead_id and l.org_id = p_org;

  insert into public.lead_events (org_id, lead_id, type, actor_id, dedupe_token, payload)
  values (
    p_org, p_lead_id, 'closed', auth.uid(), 'sheet:removed',
    jsonb_build_object(
      'outcome', 'do_not_contact',
      'source', 'sheet_import',
      'note', 'the outreach_management sheet had this row as removed'
    )
  )
  on conflict (lead_id, type, dedupe_token) do nothing;

  -- Not ON CONFLICT: suppressions_email_key is a PARTIAL unique index, and
  -- naming a partial index as an arbiter is the trap 0003 already records for
  -- leads. An existence check needs no arbiter at all.
  if v_lead.work_email_norm is not null
     and not exists (
       select 1 from public.suppressions s
        where s.org_id = p_org and s.email_norm = v_lead.work_email_norm
     )
  then
    insert into public.suppressions (org_id, email_norm, reason, lead_id, notes, created_by)
    values (p_org, v_lead.work_email_norm, 'manual_dnc', p_lead_id,
            'sheet status was removed', auth.uid());
  end if;

  if p_domain
     and v_lead.website_domain is not null
     and not exists (
       select 1 from public.suppressions s
        where s.org_id = p_org and s.domain = v_lead.website_domain
     )
  then
    insert into public.suppressions (org_id, domain, reason, lead_id, notes, created_by)
    values (p_org, v_lead.website_domain, 'manual_dnc', p_lead_id,
            'sheet status was removed', auth.uid());
  end if;

  outcome := 'closed';
end;
$$;

revoke all on function app.close_removed_lead_one(uuid, uuid, boolean, boolean)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The pass
-- ---------------------------------------------------------------------------
-- Admin only. 0025 let a plain member claim leads for themselves because that
-- is not a privileged act; this is org-wide, writes the do-not-contact list,
-- and decides where 333 leads resume in a sending sequence.
--
-- ---------------------------------------------------------------------------
-- What p_zone means, and why it has the default it has
-- ---------------------------------------------------------------------------
-- The sheet's timestamps carry no offset. The hour distribution across all 262
-- of them settles it: they cluster at 18:00-23:00 and 01:00-04:00 with nothing
-- at all between 05:00 and 12:00. Read as IST that is US business hours --
-- 09:00-14:00 Eastern is 18:30-23:30 IST, and the US afternoon runs past
-- midnight into the small hours. Read as UTC it would mean the operators sent
-- cold email to American businesses at 9pm their time, every time, and never in
-- the morning. It is IST, and the sheet having an `ist_range` column agrees.
--
-- Still a parameter, and still stated at the call site, because this is the one
-- number in the whole migration that is inferred rather than read.
--
-- ---------------------------------------------------------------------------
-- What recording history DOES to a lead
-- ---------------------------------------------------------------------------
-- This is not only bookkeeping and it should not be run as though it were.
--
-- `sent` ranks above `queued` in app.lead_status_from_events, so a lead that
-- gains its history also gains a status the planner accepts -- without anyone
-- pressing "send without an audit". Its cadence is then counted from a
-- last_sent months in the past, so the next touch is due immediately rather
-- than in three business days.
--
-- That is the intended behaviour: resuming at T4 is the entire point, and T4 is
-- overdue. But it means the first plan-sends run after this can queue a real
-- email to a real business, so the pass defaults to a dry run and reports the
-- step each lead would resume at. Read that column before turning it off.
--
-- Two things stand between this and an actual send regardless: every sheet lead
-- is currently is_qualified = false (the sheet carries no rating), and
-- org_settings.dry_run gates claim_due_sends().

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
        -- 4 is MAX_STEP. A lead that had all four is finished, and the planner
        -- drops it on `if (step > MAX_STEP) continue`.
        next_step := case when v_one.touches >= 4 then null else v_one.touches + 1 end;
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

comment on function public.backfill_sheet_touch_history(text, boolean, boolean, boolean) is
  'One-time migration helper: re-reads the outreach_management sheet''s touch '
  'timestamps out of leads.raw and records each as a sent scheduled_send plus a '
  'backdated sent event, so the sequence resumes at the right step instead of '
  'restarting at T1. Rows the sheet marked removed become do_not_contact plus a '
  'suppression. Defaults to a dry run.';

revoke all on function public.backfill_sheet_touch_history(text, boolean, boolean, boolean)
  from public, anon;
grant execute on function public.backfill_sheet_touch_history(text, boolean, boolean, boolean)
  to authenticated;
