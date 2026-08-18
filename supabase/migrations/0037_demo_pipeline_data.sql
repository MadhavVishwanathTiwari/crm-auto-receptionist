-- Leads on the board, so the board can be shown to somebody.
--
-- Seed data has lived in migrations here since 0019 (templates) and 0025
-- (operator aliases), so this survives db:push, db:reset and the demo itself.
-- Nothing removes these rows.
--
-- THEY GO IN THROUGH THE REAL MACHINERY.
--
-- Not one of status, stage, halted_at or the touch count is written directly.
-- The rows below insert leads, then lead_events and `sent` scheduled_sends, and
-- let 0004's and 0036's triggers derive the rest. That makes this an end-to-end
-- exercise of the derivation rather than a fixture: if lead_stage_from_events
-- is wrong, the board is visibly wrong, in the demo, in front of somebody.
--
-- THREE SAFETY PROPERTIES, BECAUSE THIS IS A LIVE SENDING SYSTEM
--
--   1. Every address is on example.com, which RFC 2606 reserves precisely so it
--      can never be somebody's real mailbox. This is the one that matters.
--   2. source = 'demo' on every row. leads.source is free text, so this needs
--      no schema change and puts the whole set one WHERE clause from being
--      found, counted, or removed by remove_demo_leads() at the bottom.
--   3. Every demo lead has a `replied` event, which sets halted_at, which takes
--      it out of the planner's reach. There are deliberately NO demo leads in
--      `prospect`: a sendable fake lead would pollute /queue and /settings, and
--      the Prospect column shows a count rather than cards anyway, so the demo
--      gains nothing from them. The count it shows is the real one.
--
-- claimed_by and terminal_outcome are set at INSERT, which needs no bypass:
-- leads_guard_protected is a BEFORE UPDATE trigger. The events are what make
-- the timeline honest about who did what and when.

do $demo$
declare
  v_org    uuid;
  v_owners uuid[];
  v_owner  uuid;
  v_index  int;
  v_lead   uuid;
  v_row    record;
  v_first  timestamptz;
  v_at     timestamptz;
  v_reply  timestamptz;
  v_moved  timestamptz;
  v_send   uuid;
  v_step   int;
begin
  for v_org in select id from public.orgs order by created_at loop

    -- Idempotent: a second run of this migration, or a db:reset that replays
    -- it, adds nothing.
    if exists (
      select 1 from public.leads l where l.org_id = v_org and l.source = 'demo'
    ) then
      continue;
    end if;

    -- Spread across whoever is actually in the org. An operator who has never
    -- signed in has no auth user to own a lead, which is the same rule 0025
    -- follows for the sheet import.
    select array_agg(m.user_id order by m.role, m.created_at)
      into v_owners
      from public.org_members m
     where m.org_id = v_org;

    if v_owners is null or array_length(v_owners, 1) = 0 then
      continue;
    end if;

    v_index := 0;

    for v_row in
      select * from (values
        -- company, email, first, last, title,
        -- city, state, timezone, lat, lon, rating, reviews, industry,
        -- stage, outcome, touches, deal_value, next_action, due_days
        ('Ridgeline Plumbing', 'ops@ridgeline-plumbing.example.com', 'Marcy', 'Ihde', 'Owner',
         'Boise', 'ID', 'America/Boise', 43.6150::numeric, -116.2023::numeric, 4.7::numeric, 128::int, 'Plumbing',
         'engaged', null::public.terminal_outcome, 2::int, null::numeric, 'call back about the Thursday quote'::text, -2::int),

        ('Halvorsen Heating & Air', 'front@halvorsen-hvac.example.com', 'Dane', 'Halvorsen', 'General Manager',
         'Omaha', 'NE', 'America/Chicago', 41.2565, -95.9345, 4.5, 96, 'HVAC',
         'meeting', null, 3, null, 'demo call, 2pm their time', 3),

        ('Cedar & Co Roofing', 'hello@cedar-co-roofing.example.com', 'Priya', 'Raman', 'Operations Lead',
         'Nashville', 'TN', 'America/Chicago', 36.1627, -86.7816, 4.8, 211, 'Roofing',
         'proposal', null, 3, 2491, 'chase the signed order form', -1),

        ('Bright Fork Electric', 'office@brightfork-electric.example.com', 'Tomas', 'Alvarado', 'Owner',
         'Austin', 'TX', 'America/Chicago', 30.2672, -97.7431, 4.6, 74, 'Electrical',
         'engaged', null, 2, null, null, null),

        ('Kestrel Landscaping', 'team@kestrel-landscaping.example.com', 'Anneke', 'Vos', 'Co-owner',
         'Portland', 'OR', 'America/Los_Angeles', 45.5152, -122.6784, 4.4, 52, 'Landscaping',
         'nurture', null, 4, null, 'circle back after their busy season', 21),

        ('Sunstone Dental', 'reception@sunstone-dental.example.com', 'Robin', 'Achterberg', 'Practice Manager',
         'Tucson', 'AZ', 'America/Phoenix', 32.2226, -110.9747, 4.9, 340, 'Dental',
         'meeting', null, 2, 4985, 'send the calendar invite', 1),

        ('Northbank Auto Repair', 'service@northbank-auto.example.com', 'Gus', 'Petrakis', 'Owner',
         'Spokane', 'WA', 'America/Los_Angeles', 47.6588, -117.4260, 4.3, 88, 'Auto repair',
         'engaged', null, 1, null, null, null),

        ('Marlowe Legal', 'intake@marlowe-legal.example.com', 'Yvette', 'Marlowe', 'Partner',
         'Columbus', 'OH', 'America/New_York', 39.9612, -82.9988, 4.7, 63, 'Legal',
         'proposal', null, 3, null, 'they asked for references', -4),

        ('Pinehurst Pest Control', 'book@pinehurst-pest.example.com', 'Del', 'Okafor', 'Owner',
         'Charlotte', 'NC', 'America/New_York', 35.2271, -80.8431, 4.5, 143, 'Pest control',
         'engaged', null, 2, null, null, null),

        ('Willow Creek Vet', 'desk@willowcreek-vet.example.com', 'Sana', 'Qureshi', 'Office Manager',
         'Des Moines', 'IA', 'America/Chicago', 41.5868, -93.6250, 4.8, 265, 'Veterinary',
         'meeting', null, 2, null, 'confirm who else joins the call', 2),

        ('Granite Bay Movers', 'quotes@granitebay-movers.example.com', 'Curtis', 'Nwachukwu', 'Owner',
         'Sacramento', 'CA', 'America/Los_Angeles', 38.5816, -121.4944, 4.2, 41, 'Moving',
         'nurture', null, 4, null, null, null),

        ('Lantern Row Salon', 'hey@lanternrow-salon.example.com', 'Immy', 'Bakker', 'Owner',
         'Louisville', 'KY', 'America/New_York', 38.2527, -85.7585, 4.9, 187, 'Salon',
         'engaged', null, 1, null, 'she asked what it costs', -6),

        ('Rockford Garage Doors', 'sales@rockford-doors.example.com', 'Hal', 'Brennerman', 'Sales Lead',
         'Grand Rapids', 'MI', 'America/New_York', 42.9634, -85.6681, 4.4, 77, 'Garage doors',
         'proposal', null, 3, null, null, null),

        ('Saltbox Cleaning Co', 'admin@saltbox-cleaning.example.com', 'Nkechi', 'Adeyemi', 'Founder',
         'Reno', 'NV', 'America/Los_Angeles', 39.5296, -119.8138, 4.6, 112, 'Cleaning',
         'meeting', null, 2, null, 'walk through the after-hours flow', 5),

        ('Tallgrass Chiropractic', 'front@tallgrass-chiro.example.com', 'Bo', 'Lindqvist', 'Owner',
         'Wichita', 'KS', 'America/Chicago', 37.6872, -97.3301, 4.7, 158, 'Chiropractic',
         'nurture', null, 4, null, null, null),

        ('Copperline Fencing', 'office@copperline-fencing.example.com', 'Rae', 'Studebaker', 'Owner',
         'Albuquerque', 'NM', 'America/Denver', 35.0844, -106.6504, 4.1, 34, 'Fencing',
         'engaged', null, 2, null, null, null),

        -- Closed. Each keeps the stage it died at, which is what makes "how far
        -- did this get before we lost it" answerable; columnFor() files them
        -- under their outcome regardless.
        ('Beacon Hill HVAC', 'ops@beaconhill-hvac.example.com', 'Ines', 'Dorsey', 'Owner',
         'Denver', 'CO', 'America/Denver', 39.7392, -104.9903, 4.8, 203, 'HVAC',
         'proposal', 'closed_won', 3, null, null, null),

        ('Harborview Plumbing', 'team@harborview-plumbing.example.com', 'Mack', 'Ferreira', 'Owner',
         'Tampa', 'FL', 'America/New_York', 27.9506, -82.4572, 4.6, 91, 'Plumbing',
         'meeting', 'closed_won', 2, 1994, null, null),

        ('Ironwood Contracting', 'bids@ironwood-contracting.example.com', 'Elena', 'Sokolova', 'Estimator',
         'Atlanta', 'GA', 'America/New_York', 33.7490, -84.3880, 4.3, 58, 'Contracting',
         'proposal', 'closed_lost', 4, null, null, null),

        ('Fairmount Tree Service', 'info@fairmount-tree.example.com', 'Owen', 'Kilbride', 'Owner',
         'Salt Lake City', 'UT', 'America/Denver', 40.7608, -111.8910, 4.5, 67, 'Tree service',
         'engaged', 'closed_lost', 2, null, null, null),

        ('Westgate Appliance Repair', 'help@westgate-appliance.example.com', 'Junie', 'Bosworth', 'Owner',
         'Little Rock', 'AR', 'America/Chicago', 34.7465, -92.2896, 4.0, 29, 'Appliance repair',
         'meeting', 'closed_lost', 3, null, null, null),

        ('Quarry Lane Storage', 'office@quarrylane-storage.example.com', 'Ted', 'Vandermeer', 'Manager',
         'Phoenix', 'AZ', 'America/Phoenix', 33.4484, -112.0740, 3.9, 22, 'Storage',
         'engaged', 'do_not_contact', 1, null, null, null)
      ) as t(company, email, first_name, last_name, title,
             city, state, tz, lat, lon, rating, reviews, industry,
             stage, outcome, touches, deal_value, next_action, due_days)
    loop
      v_index := v_index + 1;
      v_owner := v_owners[1 + (v_index % array_length(v_owners, 1))];

      -- The whole history is relative to now(), never a literal date, so the
      -- board still reads as live whenever the demo happens rather than going
      -- stale next month.
      v_first := now() - (interval '1 day' * (v_row.touches * 4 + 12));

      insert into public.leads (
        org_id, source, company_name, first_name, last_name, title,
        work_email, email_confidence, verification,
        city, state, country_code, latitude, longitude,
        timezone, timezone_source,
        industry, rating, reviews_count, lead_score,
        claimed_by, claimed_at, claim_count,
        terminal_outcome,
        deal_value,
        raw, created_at
      ) values (
        v_org, 'demo', v_row.company, v_row.first_name, v_row.last_name, v_row.title,
        v_row.email, 'high', 'verified',
        v_row.city, v_row.state, 'US', v_row.lat, v_row.lon,
        v_row.tz, 'coordinates',
        v_row.industry, v_row.rating, v_row.reviews, (v_row.rating * 20)::int,
        v_owner, v_first - interval '2 days', 1,
        v_row.outcome,
        v_row.deal_value,
        jsonb_build_object('demo', true, 'seeded_by', '0037_demo_pipeline_data'),
        v_first - interval '5 days'
      )
      returning id into v_lead;

      -- Claimed, credited to the operator who owns it rather than to whoever
      -- ran the migration. Same principle as 0025.
      insert into public.lead_events (org_id, lead_id, type, actor_id, occurred_at, payload)
      values (v_org, v_lead, 'claimed', v_owner, v_first - interval '2 days',
              jsonb_build_object('claim_count', 1));

      -- The touches that went out, as scheduled_sends rows plus their events.
      -- Never one without the other: the planner and /write both count steps
      -- from scheduled_sends, while status derives from the events, so an event
      -- with no row restarts the lead at T1. That is 0027's lesson.
      for v_step in 1..v_row.touches loop
        v_at := v_first + (interval '3 days' * (v_step - 1));

        insert into public.scheduled_sends (
          org_id, lead_id,
          -- mailbox_id and template_id stay null, exactly as the sheet backfill
          -- leaves them: naming an account or a template that was never used
          -- would put a false answer where the app expects a true one, and a
          -- null mailbox keeps these out of today's cap arithmetic.
          mailbox_id, template_id,
          step_number, touch_kind, status,
          scheduled_at, scheduled_local, prospect_timezone, sent_at
        ) values (
          v_org, v_lead,
          null, null,
          v_step,
          case when v_step = 1 then 'first' else 'followup' end::public.touch_kind,
          'sent',
          v_at, (v_at at time zone v_row.tz), v_row.tz, v_at
        )
        returning id into v_send;

        insert into public.lead_events (
          org_id, lead_id, type, actor_id, occurred_at, scheduled_send_id,
          dedupe_token, payload
        ) values (
          v_org, v_lead, 'sent', null, v_at, v_send,
          'demo:t' || v_step,
          jsonb_build_object('demo', true, 'step_number', v_step)
        );
      end loop;

      -- The reply. This is what halts the sequence and what makes the lead
      -- appear on the board at all: with no explicit move,
      -- app.lead_stage_from_events derives `engaged` from exactly this.
      v_reply := v_first + (interval '3 days' * v_row.touches) + interval '2 days';

      insert into public.lead_events (org_id, lead_id, type, actor_id, occurred_at, dedupe_token, payload)
      values (v_org, v_lead, 'replied', null, v_reply, 'demo:reply',
              jsonb_build_object('demo', true));

      -- Anything past `engaged` was moved there by a person, so it says so.
      v_moved := v_reply + interval '1 day';

      if v_row.stage <> 'engaged' then
        insert into public.lead_events (org_id, lead_id, type, actor_id, occurred_at, payload)
        values (v_org, v_lead, 'stage_changed', v_owner, v_moved,
                jsonb_build_object('from', 'engaged', 'to', v_row.stage,
                                   'note', 'demo history'));
      end if;

      if v_row.outcome is not null then
        insert into public.lead_events (org_id, lead_id, type, actor_id, occurred_at, payload)
        values (v_org, v_lead, 'closed', v_owner, v_moved + interval '2 days',
                jsonb_build_object('outcome', v_row.outcome, 'note', 'demo history'));
      end if;

      -- Follow-ups last, as an ordinary UPDATE — next_action and next_action_at
      -- are not guarded columns.
      if v_row.next_action is not null then
        update public.leads
           set next_action    = v_row.next_action,
               next_action_at = now() + (interval '1 day' * v_row.due_days)
         where id = v_lead;
      end if;
    end loop;
  end loop;
end
$demo$;

-- ---------------------------------------------------------------------------
-- Taking them out again
-- ---------------------------------------------------------------------------
-- Not because anything here plans to. The demo data is meant to stay, and
-- nothing above or below deletes it. But permanently seeding fabricated
-- businesses into the same table as real ones should come with the switch that
-- undoes it, rather than with a note saying somebody could write the SQL.
--
-- Admin only and dry run by default, matching repair_lead_websites() and
-- backfill_lead_owners(). Deleting a lead cascades its events and sends; the
-- append-only guard on lead_events already permits that case (0011/0012).

create or replace function public.remove_demo_leads(
  p_dry_run boolean default true
) returns table (
  lead_id uuid,
  company text,
  outcome text
)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_row record;
begin
  if v_org is null then
    raise exception 'not a member of any org' using errcode = '42501';
  end if;

  if not app.is_admin() then
    raise exception 'only an admin can remove the demo leads'
      using errcode = '42501';
  end if;

  for v_row in
    select l.id, l.company_name
      from public.leads l
     where l.org_id = v_org
       and l.source = 'demo'
     order by l.created_at
  loop
    lead_id := v_row.id;
    company := v_row.company_name;

    if p_dry_run then
      outcome := 'would remove';
    else
      delete from public.leads where id = v_row.id;
      outcome := 'removed';
    end if;

    return next;
  end loop;
end;
$$;

comment on function public.remove_demo_leads(boolean) is
  'Deletes the leads seeded by 0037 (source = ''demo''). Admin only, dry run by '
  'default. Nothing calls this automatically.';

revoke all on function public.remove_demo_leads(boolean) from public, anon;
grant execute on function public.remove_demo_leads(boolean) to authenticated;
