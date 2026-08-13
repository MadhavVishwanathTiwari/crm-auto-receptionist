-- Writing the email yourself, and still not choosing when it goes.
--
-- Everything before this migration plans a send from a TEMPLATE. That is the
-- automated half of the pipeline and it stays exactly as it is. What was
-- missing is the half the app exists for: an operator writes one email, by
-- hand, to one prospect, and the app decides the instant it leaves.
--
-- The distinction is worth stating precisely, because it is the whole product:
--
--   Instantly            you write copy once, it goes to a thousand people
--   a mail client        you write each email, and you also pick send o'clock
--   this                 you write each email, and the app picks send o'clock
--
-- So a composed send is not a new pipeline. It is a `scheduled_sends` row like
-- any other, chosen by the same prospect-local slot arithmetic, claimed under
-- the same mailbox caps, dispatched by the same function, halted by the same
-- reply. The only difference is where the words came from: `composed_body`
-- instead of `template_id`, frozen at the moment the operator hit send, and
-- dispatched verbatim with no variable substitution at all.
--
-- That last part is deliberate. A hand-written email has no {{variables}} to
-- render, which means it has no way to be skipped for a missing one, which is
-- what makes it the safe path for a lead whose import is thin.

-- ---------------------------------------------------------------------------
-- 1. The words, and who wrote them
-- ---------------------------------------------------------------------------
-- Separate from rendered_subject/rendered_body on purpose. Those are stamped by
-- mark_send_sent() and mean "what Gmail was actually handed"; these mean "what
-- a human typed". For a composed send the two end up identical, and they still
-- are not the same fact: one is an intent that can be edited before it goes,
-- the other is a receipt that cannot.

alter table scheduled_sends
  add column composed_subject text,
  add column composed_body    text,
  -- ON DELETE SET NULL, matching lead_events.actor_id: removing an operator
  -- must not delete the record of what they sent.
  add column composed_by uuid references auth.users(id) on delete set null,
  add column composed_at timestamptz;

comment on column scheduled_sends.composed_body is
  'A hand-written email, frozen at compose time. Dispatched verbatim: no '
  'variable substitution, so it can never be skipped for a missing one. '
  'Mutually exclusive with template_id in practice, though a composed send '
  'keeps the template_id it started from for provenance.';

-- Both halves of a composed send arrive together or not at all. A subject with
-- no body would dispatch as an empty email.
alter table scheduled_sends
  add constraint scheduled_sends_composed_pair
  check ((composed_subject is null) = (composed_body is null));

-- ---------------------------------------------------------------------------
-- 2. A send must have words to send
-- ---------------------------------------------------------------------------
-- A trigger rather than a CHECK constraint, and the reason is subtle:
-- template_id is `on delete set null`, so deleting a template rewrites every
-- historical row that used it. A CHECK would turn that into an error and make
-- a template undeletable once it had sent anything. The rule only needs to bind
-- at INSERT, which is the only moment a row with no words could be created.

create or replace function app.scheduled_sends_require_content()
returns trigger language plpgsql set search_path = '' as $$
begin
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

create trigger scheduled_sends_require_content
  before insert on scheduled_sends
  for each row execute function app.scheduled_sends_require_content();

-- ---------------------------------------------------------------------------
-- 3. queue_composed_send
-- ---------------------------------------------------------------------------
-- The one write into scheduled_sends a browser is allowed to make, and it is
-- SECURITY DEFINER for the same reason cancel_scheduled_send() is: the table
-- has no INSERT policy, because a hand-written UPDATE that moved a row to
-- `sent` would fabricate an email that never existed.
--
-- WHAT THIS FUNCTION DOES NOT DO IS CHOOSE THE TIME.
--
-- The instant is computed by the caller, in TypeScript, by the same
-- lib/scheduler/slots.ts the planner uses. That split is not laziness. Slot
-- arithmetic needs a holiday table, DST-correct wall-clock math and a business
-- day walker, all of which already exist, are unit tested, and would have to be
-- written a second time in plpgsql to live here. What this function DOES
-- enforce is everything that must be true regardless of who did the arithmetic:
-- the org, the claim, the timezone, the suppression list, the step, and the
-- fact that a slot cannot be in the past.

create or replace function public.queue_composed_send(
  p_lead_id         uuid,
  p_subject         text,
  p_body            text,
  p_scheduled_at    timestamptz,
  -- The prospect-local wall clock of that same instant. Passed in rather than
  -- derived so the row records the reading the operator was actually shown when
  -- they pressed send.
  p_scheduled_local timestamp,
  p_mailbox_id      uuid,
  p_step            smallint,
  -- Provenance only. Set when the operator started from a template and then
  -- edited it; the body is still what gets sent.
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

  -- A slot in the past would be invisible to claim_due_sends() the moment it
  -- was written, and the operator would watch an email never leave.
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

  -- Claiming is how two operators stay out of each other's outbox. Writing an
  -- email to somebody else's lead is exactly the collision the claim prevents.
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

  -- Non-negotiable 6. The trigger from 0015 would catch this too; failing here
  -- gives the composer a sentence to show instead of a constraint violation.
  if v_lead.timezone is null then
    raise exception 'that lead has no resolvable timezone, so it is never scheduled'
      using errcode = '22023',
            hint = 'Assign a zone on the lead. There is no state-to-zone guess '
                   'anywhere in this system, on purpose.';
  end if;

  -- Re-checked at dispatch as well, which is the check that actually binds. This
  -- one exists so an operator does not spend five minutes writing to somebody
  -- who asked to be left alone.
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

  -- display_name is the From header and {{sender_name}}. A send from a mailbox
  -- with none would put an email address where a human name belongs.
  if v_mailbox.display_name is null or btrim(v_mailbox.display_name) = '' then
    raise exception 'that mailbox has no display name yet'
      using errcode = '22023',
            hint = 'Set one on the Mailboxes screen. It is the From header.';
  end if;

  -- An already-booked touch at this step. Overwritten rather than rejected:
  -- the operator writing an email for a step the planner had queued from a
  -- template is stating a preference, and the partial unique index would
  -- otherwise turn that into a duplicate-key error they cannot act on.
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
    -- A send already out, in flight, or claimed at this step. Not ours to
    -- overwrite: `sent` in particular means the email exists in somebody's
    -- inbox and a second row for the same step would double-count the sequence.
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
      p_step, case when p_step = 1 then 'first' else 'followup' end, 'planned',
      p_scheduled_at, p_scheduled_local, v_lead.timezone,
      p_subject, p_body, v_user, now()
    )
    returning * into v_send;
  end if;

  -- The lead is now explicitly in the outbox, which is a decision somebody
  -- made and the timeline should carry. `queued` outranks `audited` in
  -- app.lead_status_from_events, so this also makes the lead sendable for its
  -- FOLLOW-UPS without an audit, which is the same assertion "send without an
  -- audit" makes on the lead drawer.
  --
  -- dedupe_token is the send row, so re-composing the same step replaces
  -- nothing and adds nothing: one queued event per booked touch.
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

comment on function public.queue_composed_send(uuid, text, text, timestamptz, timestamp, uuid, smallint, uuid) is
  'Books a hand-written email into the send queue. The caller supplies the slot '
  '(computed by lib/scheduler/slots.ts); this enforces the org, the claim, the '
  'timezone, the suppression list and the step.';

revoke all on function public.queue_composed_send(uuid, text, text, timestamptz, timestamp, uuid, smallint, uuid)
  from public, anon;
grant execute on function public.queue_composed_send(uuid, text, text, timestamptz, timestamp, uuid, smallint, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Rewriting one that has not left yet
-- ---------------------------------------------------------------------------
-- Distinct from queueing, because it must never re-time the send. An operator
-- fixing a typo three minutes before the slot expects the slot to stay put; a
-- function that silently rebooked it to tomorrow morning would be worse than no
-- edit button at all.

create or replace function public.revise_composed_send(
  p_send_id uuid,
  p_subject text,
  p_body    text
) returns public.scheduled_sends
language plpgsql security definer set search_path = '' as $$
declare
  v_org  uuid := app.current_org_id();
  v_send public.scheduled_sends;
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

  -- `planned` only. `claimed` and `sending` are excluded for the same reason
  -- cancel_scheduled_send() excludes them: the dispatcher may already be inside
  -- the Gmail call, and editing the body under it would be a lie about what
  -- went out.
  update public.scheduled_sends s
     set composed_subject = p_subject,
         composed_body    = p_body,
         composed_at      = now()
   where s.id = p_send_id
     and s.org_id = v_org
     and s.status = 'planned'
     and s.composed_body is not null
  returning s.* into v_send;

  if not found then
    raise exception 'that email is no longer editable (it may already be on its way)'
      using errcode = '55006';
  end if;

  return v_send;
end;
$$;

revoke all on function public.revise_composed_send(uuid, text, text) from public, anon;
grant execute on function public.revise_composed_send(uuid, text, text) to authenticated;
