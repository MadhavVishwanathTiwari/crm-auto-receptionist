-- A lead claimed by either of one human's accounts is theirs to write to.
--
-- 0032 made the MAILBOX check alias-aware and left the CLAIM check strict, so
-- the gate agreed with itself only for somebody holding one account. madhav
-- holds two: madhav@autoreceptionist.io signs in and connected the mailbox,
-- madhav@tryautoreceptionist.com claimed 30 leads from the sheet. /write
-- filtered on `claimed_by = auth.uid()` and never listed them, and even a
-- request made by hand would have been refused here with "that lead belongs to
-- somebody else" -- about his own leads. Those 30 were offered on no screen.
--
-- Two things:
--
--   1. public.org_operators()      the roster, so /write can list every lead
--                                  claimed by any of the caller's accounts
--   2. queue_composed_send()       the claim check through app.same_operator,
--                                  exactly as the mailbox check already was

-- ---------------------------------------------------------------------------
-- 1. Who is which human, served as data
-- ---------------------------------------------------------------------------
-- The same roster dashboard_activity() (0039) carries inside its payload, on
-- its own, because /write and the lead drawer need the grouping without the
-- rest of the dashboard's arithmetic. app.operator_aliases is revoked from
-- `authenticated` and has no API path, so this is the only way TypeScript can
-- learn that two accounts are one person without reimplementing
-- app.same_operator, which 0032 forbids.
--
-- The group key is the alias row's operator, else the account's own address,
-- so an account nobody has aliased is a group of one rather than missing.

create or replace function public.org_operators()
returns table (operator text, user_ids uuid[], emails text[])
language sql stable security definer set search_path = '' as $$
  select coalesce(a.operator, lower(btrim(u.email)), 'unknown') as operator,
         array_agg(distinct m.user_id)                          as user_ids,
         array_agg(distinct lower(btrim(u.email)))              as emails
    from public.org_members m
    join auth.users u on u.id = m.user_id
    left join app.operator_aliases a on a.email = lower(btrim(u.email))
   where m.org_id = (select app.current_org_id())
   group by 1
   order by 1;
$$;

comment on function public.org_operators() is
  'The caller''s org members grouped into humans via app.operator_aliases. '
  'The same roster dashboard_activity() carries, on its own.';

revoke all on function public.org_operators() from public, anon, authenticated;
grant execute on function public.org_operators() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. queue_composed_send(), with the claim check alias-aware
-- ---------------------------------------------------------------------------
-- 0032's body verbatim except the block marked CHANGED IN 0048. `create or
-- replace` has to restate all of it.

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

  -- CHANGED IN 0048 ---------------------------------------------------------
  -- Claimed by you, or by your other account. same_operator() is false for a
  -- null claim, so an unclaimed lead is still refused.
  if not app.same_operator(v_lead.claimed_by, v_user) then
    raise exception 'that lead belongs to somebody else'
      using errcode = '42501',
            hint = 'Claim it on the Leads screen first.';
  end if;
  -- END CHANGED IN 0048 -----------------------------------------------------

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

  -- Your own mailbox, or the one this lead's thread already started on (0032).
  if not app.same_operator(v_mailbox.user_id, v_user)
     and not exists (
       select 1 from public.scheduled_sends s
        where s.lead_id    = p_lead_id
          and s.status     = 'sent'
          and s.mailbox_id = p_mailbox_id
     )
  then
    raise exception 'that mailbox belongs to somebody else'
      using errcode = '42501',
            hint = 'An email you write leaves from your own account. Connect '
                   'one on the Mailboxes screen.';
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

revoke all on function public.queue_composed_send(uuid, text, text, timestamptz, timestamp, uuid, smallint, uuid)
  from public, anon, authenticated;
grant execute on function public.queue_composed_send(uuid, text, text, timestamptz, timestamp, uuid, smallint, uuid)
  to authenticated, service_role;
