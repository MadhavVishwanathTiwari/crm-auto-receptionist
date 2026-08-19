-- What the dashboard cannot count for itself.
--
-- The rest of this app counts in TypeScript: fetch up to 5000 leads once, run
-- lib/queue/blockers.ts and lib/pipeline/stages.ts over them. That is the right
-- shape at a few thousand rows and it is what stops /queue, /settings and
-- /pipeline ever disagreeing about a number, because each rule has exactly one
-- implementation.
--
-- Three things do not fit through it, and this function is exactly those three:
--
--   1. A DAY-BUCKETED SEND HISTORY. head:true has no GROUP BY, so fourteen
--      buckets is fourteen round trips. Count the round trips first.
--   2. THE PER-OPERATOR SPLIT. app.operator_aliases is revoked from
--      `authenticated` (0025) so that it has no API path, which is the point.
--      No TypeScript can resolve madhav's two accounts into one operator. 0032
--      answered the same question the same way: serve it as data
--      (public.mailbox_senders) and let the caller join on it.
--   3. lead_events AGGREGATES. Reply rate, bounce rate and stage movement are
--      counts over a log with a row per touch per lead. Pulling that into the
--      browser to count it would be the composed_body mistake again.
--
-- Open pipeline value is deliberately NOT computed here, and neither is "how
-- many leads are ready to send". STAGE_WEIGHT, the deal_value
-- null-means-org-default rule and classifyLead's seven-way precedence live in
-- lib/, two screens already render them, and a second implementation in plpgsql
-- would eventually put a different headline number on the dashboard than on the
-- board -- in front of somebody.
--
-- jsonb rather than `returns table`: the payload is heterogeneous.
-- background_jobs_status() returns a table because its rows are one shape.
-- These are a series, three summaries and a roster.
--
-- app.current_org_id() is read ONCE into a variable and never called inside a
-- query. Inside a definer function RLS is bypassed, so 0030's InitPlan rule
-- does not apply to the predicates here, but a definer helper in a WHERE clause
-- is still one call per row, and the discipline is the same one set_lead_stage
-- and close_lead already follow.

create or replace function public.dashboard_activity(p_days int default 14)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org   uuid := app.current_org_id();
  v_zone  text;
  v_days  int  := least(greatest(coalesce(p_days, 14), 1), 90);
  v_today date;
  v_from  timestamptz;
  v_out   jsonb;
begin
  if v_org is null then
    raise exception 'not a member of any org' using errcode = '42501';
  end if;

  -- The OPERATOR's day. Not the prospect's, and never UTC. This is a report
  -- about what these two people sent, so it buckets in their wall clock;
  -- non-negotiable 5 governs when an email LEAVES, which is bookSlot's
  -- business. Per-mailbox headroom below is different again and counts
  -- cap_date, stamped in the MAILBOX's zone at claim, because that is the day
  -- the cap actually resets in.
  select os.operator_timezone into v_zone
    from public.org_settings os where os.org_id = v_org;
  v_zone := coalesce(v_zone, 'America/New_York');

  v_today := (now() at time zone v_zone)::date;
  v_from  := ((v_today - (v_days - 1))::timestamp) at time zone v_zone;

  select jsonb_build_object(
    'generated_at', now(),
    'zone',  v_zone,
    'days',  v_days,

    -- One scan of the window, then gap-filled by joining the series onto it. A
    -- day with no sends is a fact worth drawing; a chart that omits it
    -- compresses a quiet week into a busy one.
    'series', (
      with sent as (
        select ((s.sent_at at time zone v_zone)::date) as day, count(*) as n
          from public.scheduled_sends s
         where s.org_id = v_org
           and s.status = 'sent'
           and s.sent_at >= v_from
         group by 1
      )
      select coalesce(
        jsonb_agg(jsonb_build_object('day', g::date, 'sent', coalesce(sent.n, 0))
                  order by g), '[]'::jsonb)
        from generate_series(v_today - (v_days - 1), v_today, interval '1 day') g
        left join sent on sent.day = g::date
    ),

    'sends', (
      select jsonb_build_object(
        'planned', count(*) filter (where s.status = 'planned'),
        'blocked', count(*) filter (where s.status = 'blocked'),
        'failed',  count(*) filter (where s.status = 'failed' and s.updated_at >= v_from),
        'sent',    count(*) filter (where s.status = 'sent'   and s.sent_at   >= v_from),
        -- What somebody typed on /write, as opposed to what the planner built
        -- from a template. composed_body is the only thing that tells them apart.
        'written', count(*) filter (where s.status = 'sent'   and s.sent_at   >= v_from
                                      and s.composed_body is not null)
      )
      from public.scheduled_sends s where s.org_id = v_org
    ),

    'mailboxes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'mailbox_id', m.id,
        'email',      m.email,
        'user_id',    m.user_id,
        'timezone',   m.timezone,
        'daily_cap',  m.daily_cap,
        'sendable',   m.is_sendable,
        -- cap_date, in the mailbox's own zone. /mailboxes reads it exactly this
        -- way, and any other reading puts a headroom number on screen that the
        -- cap is not the one enforcing.
        'used_today', (select count(*) from public.scheduled_sends s
                        where s.mailbox_id = m.id
                          and s.status in ('claimed','sending','sent')
                          and s.cap_date = (now() at time zone m.timezone)::date),
        'sent_window',(select count(*) from public.scheduled_sends s
                        where s.mailbox_id = m.id
                          and s.status = 'sent' and s.sent_at >= v_from)
      ) order by m.created_at), '[]'::jsonb)
      from public.mailboxes m where m.org_id = v_org
    ),

    -- Raw counts, not rates. The screen divides, and can decline to when the
    -- denominator is too small to mean anything.
    'events', (
      select jsonb_build_object(
        'replied',      count(*) filter (where e.type = 'replied'),
        'bounced',      count(*) filter (where e.type = 'bounced'),
        'unsubscribed', count(*) filter (where e.type = 'unsubscribed'),
        'closed',       count(*) filter (where e.type = 'closed')
      )
      from public.lead_events e
      where e.org_id = v_org and e.occurred_at >= v_from
    ),

    'stage_moves', (
      select coalesce(jsonb_object_agg(t.to_stage, t.n), '{}'::jsonb)
        from (select e.payload->>'to' as to_stage, count(*) as n
                from public.lead_events e
               where e.org_id = v_org and e.type = 'stage_changed'
                 and e.occurred_at >= v_from and e.payload->>'to' is not null
               group by 1) t
    ),

    'open_alerts', (
      select count(*) from public.alerts a
       where a.org_id = v_org and a.acknowledged_at is null
    ),

    -- Alias resolution served as DATA, exactly as public.mailbox_senders()
    -- serves it to lib/scheduler/routing.ts. This is the only way TypeScript
    -- can learn that madhav's two accounts are one person without
    -- reimplementing app.same_operator, which is the thing 0032 forbids.
    'operators', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'operator', o.operator,
               'user_ids', o.user_ids,
               'emails',   o.emails) order by o.operator), '[]'::jsonb)
        from (select coalesce(a.operator, lower(btrim(u.email)), 'unknown') as operator,
                     array_agg(distinct m.user_id)                          as user_ids,
                     array_agg(distinct lower(btrim(u.email)))              as emails
                from public.org_members m
                join auth.users u on u.id = m.user_id
                left join app.operator_aliases a on a.email = lower(btrim(u.email))
               where m.org_id = v_org
               group by 1) o
    ),

    -- Attributed by the MAILBOX the email left from, not by leads.claimed_by: a
    -- pinned thread keeps going out of the original sender's account after the
    -- lead is reassigned (0032), and that send is theirs.
    'sent_by_operator', (
      select coalesce(jsonb_object_agg(t.operator, t.n), '{}'::jsonb)
        from (select coalesce(a.operator, lower(btrim(u.email)), 'unknown') as operator,
                     count(*) as n
                from public.scheduled_sends s
                join public.mailboxes mb on mb.id = s.mailbox_id
                join auth.users u        on u.id  = mb.user_id
                left join app.operator_aliases a on a.email = lower(btrim(u.email))
               where s.org_id = v_org and s.status = 'sent' and s.sent_at >= v_from
               group by 1) t
    )
  ) into v_out;

  return v_out;
end;
$$;

comment on function public.dashboard_activity(int) is
  'Everything /dashboard cannot count in TypeScript: the day-bucketed send '
  'series, lead_events aggregates, per-mailbox headroom by cap_date, and the '
  'operator roster with app.operator_aliases already collapsed. Lead-derived '
  'figures stay in lib/pipeline/stages.ts and lib/queue/blockers.ts.';

revoke all on function public.dashboard_activity(int) from public, anon;
grant execute on function public.dashboard_activity(int) to authenticated;

-- No new indexes. The existing ones cover every predicate above --
-- lead_events_org_type_idx (0003), scheduled_sends_org_status_idx and
-- scheduled_sends_cap_idx (0015), alerts_open_idx (0013) -- and at two
-- operators and roughly fifteen thousand sends a year a sequential scan of any
-- of these is sub-millisecond. Nothing in this app does heavy work; speculative
-- indexes here would be cost with no measurement behind it.
