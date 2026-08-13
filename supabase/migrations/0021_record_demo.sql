-- The one legitimate writer of the demo columns.
--
-- 0004 refuses any UPDATE that touches demo_slug, demo_txt_url, demo_web_url or
-- demo_ready_at, with the message "demo URLs are written by the demo ingest
-- API". This is that writer. The guard binds the service role too, so the route
-- cannot simply UPDATE the row: it has to come through here, which is the point
-- of writing the rule as a trigger rather than as a convention in a handler.
--
-- One transaction, three effects, for the same reason mark_send_sent() is one:
-- the row, the `demo_ready` event, and the idempotency. A demo that lands on
-- the lead without an event is invisible in the timeline, and an event without
-- the row means T2 refuses to send while the timeline says the demo arrived.
--
-- Idempotent by construction. The Auto-Receptionist job re-POSTs a backfilled
-- row whenever it re-runs, and demo_ready_at is what gates T2: bumping it on
-- every re-post would keep moving the moment the demo "arrived".

create or replace function public.record_demo(
  p_lead_id  uuid,
  p_slug     text,
  p_txt_url  text,
  p_web_url  text default null,
  p_payload  jsonb default '{}'::jsonb
) returns public.leads
language plpgsql security definer set search_path = '' as $$
declare
  v_previous text;
  v_lead     public.leads;
begin
  if p_slug is null or btrim(p_slug) = '' then
    raise exception 'a demo needs a slug' using errcode = '22023';
  end if;
  if p_txt_url is null or btrim(p_txt_url) = '' then
    raise exception 'a demo needs a URL' using errcode = '22023';
  end if;

  v_previous := coalesce(current_setting('app.bypass_lead_guard', true), 'off');
  perform set_config('app.bypass_lead_guard', 'on', true);

  update public.leads l
     set demo_slug     = btrim(p_slug),
         demo_txt_url  = btrim(p_txt_url),
         demo_web_url  = nullif(btrim(coalesce(p_web_url, '')), ''),
         -- coalesce, not now(): the first delivery is when the demo became
         -- available, and every later re-post is the same fact restated.
         demo_ready_at = coalesce(l.demo_ready_at, now())
   where l.id = p_lead_id
  returning l.* into v_lead;

  perform set_config('app.bypass_lead_guard', v_previous, true);

  -- Tested on the returned row rather than on FOUND, and that is not a style
  -- choice: PERFORM sets FOUND itself, and set_config() returns a row, so by
  -- this line FOUND is true no matter what the UPDATE matched.
  if v_lead.id is null then
    return null;
  end if;

  -- The slug as dedupe_token against the unique (lead_id, type, dedupe_token):
  -- a rebuild under the same slug records nothing new, a rebuild under a
  -- different one is a genuinely different demo and gets its own event.
  insert into public.lead_events (org_id, lead_id, type, actor_id, payload, dedupe_token)
  values (
    v_lead.org_id, v_lead.id, 'demo_ready', null,
    p_payload || jsonb_build_object('slug', btrim(p_slug), 'demo_url', btrim(p_txt_url)),
    btrim(p_slug)
  )
  on conflict (lead_id, type, dedupe_token) do nothing;

  return v_lead;
end;
$$;

comment on function public.record_demo(uuid, text, text, text, jsonb) is
  'Writes a built demo onto a lead and logs demo_ready. The only path past the demo-column guard.';

-- Not granted to `authenticated`. The demo columns are machine-written by
-- design, and a browser that could call this could put any URL in a live email.
revoke all on function public.record_demo(uuid, text, text, text, jsonb) from public;
