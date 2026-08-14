-- An email leaves from the mailbox of the person who wrote it.
--
-- It did not. pickMailbox() was handed every sendable mailbox in the org and
-- returned the emptiest one, so an email Ojas hand-wrote, to a lead Ojas had
-- claimed, went out from madhav@ whenever madhav@ had more room that day. The
-- prospect's reply then landed in Madhav's inbox, and the starter templates on
-- Ojas's screen rendered {{sender_name}} as "Madhav", because that too was
-- resolved as "the first mailbox with a display name".
--
-- Nothing about this was an RLS failure. Org scoping held throughout. The gap
-- was narrower: mailboxes.user_id has existed since 0013 and the send path
-- never read it, so no layer -- not the composer, not the planner, not this
-- RPC -- ever had an opinion about WHOSE mailbox was appropriate.
--
-- Three things here:
--
--   1. app.same_operator()        two accounts, one human (0009's mess again)
--   2. public.mailbox_senders()   the same answer, in the shape TypeScript needs
--   3. queue_composed_send()      restated with the check that actually binds
--   4. reroute_planned_sends_to_owner()   repair for what is already queued

-- ---------------------------------------------------------------------------
-- 1. Are these two accounts the same person?
-- ---------------------------------------------------------------------------
-- Almost always answered by `a = b`. It needs more than that here because
-- madhav holds two accounts in this org -- madhav@autoreceptionist.io connected
-- the mailbox, madhav@tryautoreceptionist.com claimed the leads -- and a strict
-- user_id comparison would refuse to send to any of his 30 leads while working
-- perfectly for Ojas. That is not a hypothetical; it is the state of the
-- project today.
--
-- app.operator_aliases already records both addresses as operator 'madhav'.
-- 0026 established the rule for reading it, and this keeps it: an exact match
-- is the strongest evidence there is, the group is only consulted when there is
-- no exact match to consult.

create or replace function app.same_operator(p_a uuid, p_b uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when p_a is null or p_b is null then false
    when p_a = p_b                  then true
    else exists (
      select 1
        from auth.users ua
        join app.operator_aliases aa on aa.email = lower(btrim(ua.email))
        join app.operator_aliases ab on ab.operator = aa.operator
        join auth.users ub on lower(btrim(ub.email)) = ab.email
       where ua.id = p_a
         and ub.id = p_b
    )
  end;
$$;

comment on function app.same_operator(uuid, uuid) is
  'True when two auth accounts are the same human, via app.operator_aliases. '
  'Exact id first; the alias group is the fallback, matching 0026.';

revoke all on function app.same_operator(uuid, uuid) from public, anon;
grant execute on function app.same_operator(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Which accounts may send from which mailbox
-- ---------------------------------------------------------------------------
-- lib/scheduler/routing.ts needs the same answer as the RPC below, and must not
-- reimplement alias resolution in TypeScript to get it: two copies of "who is
-- this person" would eventually disagree, and the disagreement shows up as an
-- email from the wrong address, which is the bug being fixed.
--
-- So it is served as data. Tiny -- mailboxes times members, six rows here -- and
-- read once per page render alongside the queries already in flight.
--
-- The org argument exists for the cron routes, which run as the service role and
-- have no auth.uid() for app.current_org_id() to resolve. An authenticated
-- caller may only ever ask about their own org, whatever they pass.

create or replace function public.mailbox_senders(p_org uuid default null)
returns table (mailbox_id uuid, user_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_caller_org uuid := app.current_org_id();
  v_org        uuid := coalesce(p_org, v_caller_org);
begin
  if v_org is null then
    return;
  end if;

  if v_caller_org is not null and v_org <> v_caller_org then
    raise exception 'that is not your org' using errcode = '42501';
  end if;

  return query
    select m.id, om.user_id
      from public.mailboxes m
      join public.org_members om on om.org_id = m.org_id
     where m.org_id = v_org
       and m.user_id is not null
       and app.same_operator(m.user_id, om.user_id);
end;
$$;

comment on function public.mailbox_senders(uuid) is
  'Per mailbox, the org accounts permitted to send from it. Normally just the '
  'owner; more when one human holds several accounts (app.operator_aliases).';

revoke all on function public.mailbox_senders(uuid) from public, anon;
grant execute on function public.mailbox_senders(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. queue_composed_send(), with the check that binds
-- ---------------------------------------------------------------------------
-- Filtering the candidate list in TypeScript is what makes the composer offer
-- the right mailbox. It is not what makes the wrong one impossible: the RPC is
-- reachable by any authenticated member of the org, and until now it validated
-- only that the mailbox was in-org and sendable. This is the gate.
--
-- Everything else is 0024 verbatim, because `create or replace` has to restate
-- the whole body. The new block is the one marked NEW IN 0032.

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

  -- NEW IN 0032 -------------------------------------------------------------
  -- Your own mailbox, or the one this lead's thread already started on.
  --
  -- The second half is not a loophole, it is the harder requirement of the two.
  -- dispatch-sends looks the prior Gmail threadId up per LEAD and hands it to
  -- whichever mailbox the send names; a threadId only exists inside the account
  -- that issued it. So a lead whose T1 went out from a colleague's mailbox must
  -- keep using it, and refusing that here would stall the sequence permanently.
  --
  -- `is distinct from` via same_operator() also rejects an unowned mailbox
  -- (user_id null). Nobody should be sending from an orphan.
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
  -- END NEW IN 0032 ---------------------------------------------------------

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
      -- 0024's fix. An untyped CASE is text, and Postgres will not assign text
      -- to an enum column.
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

-- ---------------------------------------------------------------------------
-- 4. Repairing what is already queued
-- ---------------------------------------------------------------------------
-- Fixing the routing forward does nothing for the sends already sitting on the
-- wrong mailbox, and those go out within the day. Same shape as
-- backfill_lead_owners() and backfill_sheet_touch_history(): admin only, dry run
-- by default, re-runnable, and it reports every row it considered rather than
-- only the ones it changed.
--
-- It does NOT re-time anything. The slot an operator was shown is the slot they
-- were promised, and capacity is re-checked by claim_due_sends() at dispatch,
-- which is the authority. Moving a send to a mailbox with a full day means it
-- waits, not that it double-sends.

create or replace function public.reroute_planned_sends_to_owner(
  p_dry_run boolean default true
) returns table (
  lead_id      uuid,
  company      text,
  send_id      uuid,
  step_number  smallint,
  from_mailbox text,
  to_mailbox   text,
  outcome      text
)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_row record;
  v_target uuid;
  v_target_email text;
begin
  if v_org is null then
    raise exception 'not a member of any org' using errcode = '42501';
  end if;

  -- Matching reassign_lead(): handing a lead's send to a different account is
  -- an ownership decision, and those need admin.
  if not app.is_admin() then
    raise exception 'only an admin can reroute sends' using errcode = '42501';
  end if;

  for v_row in
    select s.id            as send_id,
           s.lead_id       as lead_id,
           s.step_number   as step_number,
           s.mailbox_id    as mailbox_id,
           l.company_name  as company,
           l.claimed_by    as owner,
           mb.email        as from_email,
           exists (
             select 1 from public.scheduled_sends p
              where p.lead_id = s.lead_id
                and p.status = 'sent'
                and p.mailbox_id is not null
           ) as pinned
      from public.scheduled_sends s
      join public.leads l on l.id = s.lead_id
      left join public.mailboxes mb on mb.id = s.mailbox_id
     where s.org_id = v_org
       and s.status in ('planned', 'blocked')
     order by s.scheduled_at
  loop
    lead_id      := v_row.lead_id;
    company      := v_row.company;
    send_id      := v_row.send_id;
    step_number  := v_row.step_number;
    from_mailbox := v_row.from_email;
    to_mailbox   := null;

    -- A lead with history is committed to the account that holds the thread,
    -- whoever owns the lead now. Moving it is the threading break, not the fix.
    if v_row.pinned then
      outcome := 'pinned to its thread, left alone';
      return next;
      continue;
    end if;

    if v_row.owner is null then
      outcome := 'lead is unclaimed, left alone';
      return next;
      continue;
    end if;

    if v_row.mailbox_id is not null
       and exists (
         select 1 from public.mailboxes m
          where m.id = v_row.mailbox_id
            and app.same_operator(m.user_id, v_row.owner)
       )
    then
      to_mailbox := v_row.from_email;
      outcome    := 'already correct';
      return next;
      continue;
    end if;

    -- The owner's mailbox. Exact ownership before the alias group, same order
    -- as everywhere else. No capacity arithmetic here on purpose: that lives in
    -- lib/scheduler/book.ts and a second copy in plpgsql would eventually
    -- disagree with it. With one mailbox per operator the ordering is moot.
    select m.id, m.email
      into v_target, v_target_email
      from public.mailboxes m
     where m.org_id = v_org
       and m.is_sendable
       and app.same_operator(m.user_id, v_row.owner)
     order by (m.user_id = v_row.owner) desc, m.id
     limit 1;

    if v_target is null then
      outcome := 'owner has no sendable mailbox, left alone';
      return next;
      continue;
    end if;

    to_mailbox := v_target_email;

    if p_dry_run then
      outcome := 'would move';
    else
      -- mailbox_id only. cap_date is stamped by claim_due_sends() at claim
      -- time and is still null on a planned row, and scheduled_at is
      -- deliberately untouched, so the require_timezone trigger (scoped to the
      -- re-timing columns) does not fire.
      update public.scheduled_sends s
         set mailbox_id = v_target
       where s.id = v_row.send_id;
      outcome := 'moved';
    end if;

    return next;
  end loop;
end;
$$;

comment on function public.reroute_planned_sends_to_owner(boolean) is
  'Repair helper: re-points planned/blocked sends to their lead owner mailbox. '
  'Skips leads pinned to a thread by a prior sent touch. Defaults to a dry run.';

revoke all on function public.reroute_planned_sends_to_owner(boolean) from public, anon;
grant execute on function public.reroute_planned_sends_to_owner(boolean) to authenticated;
