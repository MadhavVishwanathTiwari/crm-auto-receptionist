-- A sheet cannot record an email from before it existed.
--
-- Nuvo HVAC's first_touch cell reads `06/08/25 22:41`: a typo for 26. The
-- parser read it faithfully as 6 Aug 2025, a year before the real email, so the
-- 36-hour window record_mailbox_touches() (0042) uses to match a sheet cell to
-- a Sent-folder message never paired them. Nuvo got a phantom T1 dated 2025 and
-- its one real email became T2, which put /write a step ahead of the prospect.
-- It is the only cell in the sheet with a year other than 26, and the only
-- `sent` row dated outside 2026.
--
-- Two things:
--
--   1. parse_sheet_timestamp() returns NULL for a date before the sheet began,
--      or more than a day in the future. NULL is what it already returns for a
--      cell it cannot read, so both 0027 and 0042 report the cell instead of
--      recording it. The earliest real timestamp is 16/07/26; June 2026 leaves
--      a month of slack and still refuses every plausible year typo.
--   2. The one row it already produced is cancelled and the lead renumbered.
--      Written generically, but it touches exactly one row today.
--
-- The phantom's `sent` event stays in the log: lead_events refuses updates and
-- deletes, deliberately. It changes nothing -- status is `sent` either way, and
-- nothing counts touches from events.

create or replace function app.parse_sheet_timestamp(p_raw text, p_zone text)
-- STABLE, not IMMUTABLE: `at time zone <name>` reads the tz database, and that
-- can change under a running server. now() is stable within a statement too.
returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  v_text   text;
  v_parts  text[];
  v_day    int;
  v_month  int;
  v_year   int;
  v_hour   int;
  v_min    int;
  v_sec    int;
  v_parsed timestamptz;
begin
  if p_raw is null or btrim(p_raw) = '' or p_zone is null then
    return null;
  end if;

  -- The dirty shapes, normalized away before matching. See 0027.
  v_text := btrim(p_raw);
  v_text := regexp_replace(v_text, '\s+', ' ', 'g');          -- doubled spaces
  v_text := regexp_replace(v_text, '\s*/\s*', '/', 'g');      -- `31/ 07/26`
  v_text := regexp_replace(v_text, '/([0-9]{1,2}:[0-9]{2})', ' \1');  -- `26/ 21:40`

  -- Day first. Not month first: see 0027.
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

  if v_year < 100 then
    v_year := 2000 + v_year;
  end if;

  if v_month < 1 or v_month > 12
     or v_day < 1 or v_day > 31
     or v_hour > 23 or v_min > 59 or v_sec > 59 then
    return null;
  end if;

  begin
    v_parsed := make_timestamp(v_year, v_month, v_day, v_hour, v_min, v_sec)
                  at time zone p_zone;
  exception when others then
    return null;
  end;

  -- 0043: the sheet was started in July 2026. A date before it, or one that has
  -- not happened yet, is a typo, and a typo read literally is a touch that
  -- never happened.
  if v_parsed < timestamptz '2026-06-01 00:00:00+00'
     or v_parsed > now() + interval '1 day' then
    return null;
  end if;

  return v_parsed;
end;
$$;

comment on function app.parse_sheet_timestamp(text, text) is
  'DD/MM/YY[YY] HH:MM[:SS] as written by the outreach_management sheet, read '
  'day-first and interpreted in the zone supplied. NULL on anything it cannot '
  'read, and on a date before the sheet existed or in the future (0043), so a '
  'bad cell is reported rather than guessed at.';

revoke all on function app.parse_sheet_timestamp(text, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The row the typo already produced
-- ---------------------------------------------------------------------------
-- Cancelled rather than deleted: it stays visible as what it was. Then every
-- remaining sent row of that lead is renumbered by date, lowest first, so each
-- row only ever moves onto a step the row before it has already left.

do $$
declare
  v_lead uuid;
  v_row  record;
  v_step int;
begin
  for v_lead in
    select distinct s.lead_id
      from public.scheduled_sends s
     where s.status = 'sent'
       and s.mailbox_id is null
       and s.sent_at < timestamptz '2026-06-01 00:00:00+00'
  loop
    update public.scheduled_sends s
       set status = 'cancelled',
           outcome_reason = 'recorded from a sheet cell dated before the sheet existed '
                            '(a year typo); the real email is the Sent-folder row'
     where s.lead_id = v_lead
       and s.status = 'sent'
       and s.mailbox_id is null
       and s.sent_at < timestamptz '2026-06-01 00:00:00+00';

    v_step := 0;
    for v_row in
      select s.id, s.step_number
        from public.scheduled_sends s
       where s.lead_id = v_lead
         and s.status = 'sent'
       order by s.sent_at, s.step_number
    loop
      v_step := v_step + 1;
      if v_row.step_number <> v_step then
        update public.scheduled_sends s
           set step_number = v_step,
               touch_kind  = (case when v_step = 1 then 'first' else 'followup' end)::public.touch_kind
         where s.id = v_row.id;
      end if;
    end loop;
  end loop;
end;
$$;
