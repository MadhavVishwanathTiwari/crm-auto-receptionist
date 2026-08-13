-- queue_composed_send() could never insert a NEW row.
--
-- `case when p_step = 1 then 'first' else 'followup' end` is typed text, and
-- scheduled_sends.touch_kind is the enum. Postgres refuses the assignment with
-- 42804 rather than coercing it, so every first written email to a lead failed
-- while the UPDATE branch (replacing a send the planner had already booked)
-- worked fine. Exactly the shape of bug an integration test exists to catch:
-- the feature demoed correctly on any lead that already had something queued.
--
-- Only the two lines around the insert change. The rest is 0023 verbatim,
-- because create or replace has to restate the whole body.

create or replace function public.queue_composed_send(
  p_lead_id         uuid,
  p_subject         text,
  p_body            text,
  p_scheduled_at    timestamptz,
  p_scheduled_local timestamp,
  p_mailbox_id      uuid,
  p_step            smallint,
  p_template_id     uuid default null
) returns public.scheduled_sends
language plpgsql security definer set search_path = '' as $$
declare
  v_org     uuid := app.current_org_id();
  v_user    uuid := auth.uid();
  v_lead    public.leads;
  v_mailbox public.mailboxes;
  v_send    public.scheduled_sends;
  v_existing public.scheduled_sends;
begin
  if v_org is null then
    raise exception 'not a member of any org' using errcode = '42501';
  end if;

  if p_subject is null or btrim(p_subject) = '' then
    raise exception 'an email needs a subject' using errcode = '22023';
  end if;
  if p_body is null or btrim(p_body) = '' then
    raise exception 'an email needs a body' using errcode = '22023';
  end if;
  if p_step is null or p_step < 1 or p_step > 4 then
    raise exception 'step must be between 1 and 4' using errcode = '22023';
  end if;

  if p_scheduled_at is null or p_scheduled_at <= now() then
    raise exception 'that slot has already passed'
      using errcode = '22023',
            hint = 'Reload the composer so it can pick the next open slot.';
  end if;

  select * into v_lead
    from public.leads l
   where l.id = p_lead_id and l.org_id = v_org;

  if not found then
    raise exception 'that lead is not available' using errcode = '42501';
  end if;

  if v_lead.claimed_by is distinct from v_user then
    raise exception 'that lead belongs to somebody else'
      using errcode = '42501',
            hint = 'Claim it on the Leads screen first.';
  end if;

  if v_lead.archived_at is not null
     or v_lead.halted_at is not null
     or v_lead.terminal_outcome is not null then
    raise exception 'that lead is closed or halted'
      using errcode = '55006';
  end if;

  if v_lead.work_email is null or btrim(v_lead.work_email) = '' then
    raise exception 'that lead has no work email, which is the only send target'
      using errcode = '22023';
  end if;

  if v_lead.timezone is null then
    raise exception 'that lead has no resolvable timezone, so it is never scheduled'
      using errcode = '22023',
            hint = 'Assign a zone on the lead. There is no state-to-zone guess '
                   'anywhere in this system, on purpose.';
  end if;

  if exists (
    select 1 from public.suppressions s
     where s.org_id = v_org
       and (s.email_norm = v_lead.work_email_norm
            or (s.domain is not null and s.domain = v_lead.website_domain))
  ) then
    raise exception 'that address is on the do-not-contact list'
      using errcode = '55006';
  end if;

  select * into v_mailbox
    from public.mailboxes m
   where m.id = p_mailbox_id and m.org_id = v_org and m.is_sendable;

  if not found then
    raise exception 'that mailbox is not connected or not sendable'
      using errcode = '22023';
  end if;

  if v_mailbox.display_name is null or btrim(v_mailbox.display_name) = '' then
    raise exception 'that mailbox has no display name yet'
      using errcode = '22023',
            hint = 'Set one on the Mailboxes screen. It is the From header.';
  end if;

  select * into v_existing
    from public.scheduled_sends s
   where s.lead_id = p_lead_id
     and s.step_number = p_step
     and s.status in ('planned', 'blocked')
   for update;

  if found then
    update public.scheduled_sends s
       set composed_subject = p_subject,
           composed_body    = p_body,
           composed_by      = v_user,
           composed_at      = now(),
           template_id      = p_template_id,
           mailbox_id       = p_mailbox_id,
           status           = 'planned',
           scheduled_at     = p_scheduled_at,
           scheduled_local  = p_scheduled_local,
           prospect_timezone = v_lead.timezone,
           outcome_reason   = null,
           plan_attempt     = s.plan_attempt + 1
     where s.id = v_existing.id
    returning s.* into v_send;
  else
    if exists (
      select 1 from public.scheduled_sends s
       where s.lead_id = p_lead_id
         and s.step_number = p_step
         and s.status in ('claimed', 'sending', 'sent')
    ) then
      raise exception 'step % has already gone out for this lead', p_step
        using errcode = '55006';
    end if;

    insert into public.scheduled_sends (
      org_id, lead_id, mailbox_id, template_id,
      step_number, touch_kind, status,
      scheduled_at, scheduled_local, prospect_timezone,
      composed_subject, composed_body, composed_by, composed_at
    ) values (
      v_org, p_lead_id, p_mailbox_id, p_template_id,
      p_step,
      -- The fix. An untyped CASE is text, and Postgres will not assign text to
      -- an enum column.
      (case when p_step = 1 then 'first' else 'followup' end)::public.touch_kind,
      'planned',
      p_scheduled_at, p_scheduled_local, v_lead.timezone,
      p_subject, p_body, v_user, now()
    )
    returning * into v_send;
  end if;

  insert into public.lead_events (
    org_id, lead_id, type, actor_id, payload, scheduled_send_id, dedupe_token
  ) values (
    v_org, p_lead_id, 'queued', v_user,
    jsonb_build_object(
      'step_number', p_step,
      'composed',    true,
      'subject',     p_subject,
      'scheduled_local', to_char(p_scheduled_local, 'YYYY-MM-DD HH24:MI'),
      'prospect_timezone', v_lead.timezone
    ),
    v_send.id, 'composed:' || v_send.id::text
  )
  on conflict (lead_id, type, dedupe_token) do nothing;

  return v_send;
end;
$$;
