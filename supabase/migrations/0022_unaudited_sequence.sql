-- An audit stops being a precondition for sending.
--
-- The rule until now was that every lead had to be audited before its first
-- touch, and 0019's copy enforced it by construction: all four templates quote
-- the audit back, in the SUBJECT as well as the body, so a lead with no
-- lead_evidence row cannot render any of them. That is right for a lead worth
-- the effort. It is wrong for the rest of an import, where auditing a thousand
-- scraped rows by hand costs more than the leads are worth, and the operator
-- would rather send generic copy than nothing.
--
-- So there are now two first touches, and the choice between them is data:
--
--   angle_type = 'soft_text_audit'  the audit copy. Selected when the LEAD
--                                   carries that angle, which the audit screen
--                                   now stamps on it.
--   angle_type = null               the generic copy. The fallback in
--                                   templateFor(), so a lead with no angle,
--                                   which means a lead nobody audited, gets it.
--
-- No planner change was needed for the selection: templateFor() has preferred
-- an angle match over the null slot since 0014, and the pair of partial unique
-- indexes already allows exactly one active template per (step, angle) plus one
-- per (step, either). This migration only fills the empty half of that design.
--
-- What DOES gate an unaudited lead is the `queued` event, which the leads
-- screen now writes: status `queued` outranks `audited`, and the planner has
-- accepted both since 0015. An operator therefore says "send this one without
-- an audit" explicitly, per lead. It is not a global switch, because the
-- decision is about one lead's quality and nothing else knows that.

-- ---------------------------------------------------------------------------
-- 1. The existing four become the audit variants
-- ---------------------------------------------------------------------------
-- They were seeded with angle_type null, which made them the fallback for every
-- lead including the ones with no evidence to quote. Pinning them to the angle
-- is what stops that.

update templates
   set angle_type = 'soft_text_audit'
 where angle_type is null
   and name in (
     'T1 audit callback',
     'T2 demo link',
     'T3 still live',
     'T4 closing the file'
   );

-- ---------------------------------------------------------------------------
-- 2. "however" was a typo for "how"
-- ---------------------------------------------------------------------------
-- It appears in the T1 subject and, with a Re: in front, in the other three.
-- Caught by reading the copy rather than by the linter, which has no opinion
-- about words that are spelled correctly and mean the wrong thing.

update templates
   set subject = replace(subject, 'however ', 'how ')
 where subject like '%however %';

-- ---------------------------------------------------------------------------
-- 3. The generic set
-- ---------------------------------------------------------------------------
-- Same voice, same structure, no audit variables. The only variables used are
-- company_name, demo_url and sender_name:
--
--   * company_name comes from the Maps scrape and is present on every lead.
--   * sender_name is mailboxes.display_name, which /settings refuses to call
--     ready until it is set.
--   * demo_url only appears in the two steps carrying requires_demo, which the
--     planner will not schedule until leads.demo_ready_at exists.
--
-- city, state and industry are deliberately absent even though they would read
-- better. renderTemplate() treats a null variable as a missing one and the
-- dispatcher skips the send rather than emailing a hole, so every variable here
-- has to be one that cannot be null. That is a data problem, not a copy
-- problem: add them once the import fills them reliably.

insert into templates (org_id, name, step_number, angle_type, subject, body, requires_demo, is_active)
select
  o.id,
  seed.name,
  seed.step_number,
  null::angle_type,
  seed.subject,
  seed.body,
  seed.requires_demo,
  false
from orgs o
cross join (
  values
    (
      'T1 no audit',
      1::smallint,
      $subj${{company_name}} and the calls that ring out$subj$,
      $tpl$When the phone goes at {{company_name}} and everyone is already on a job, it rings out. The customer does not leave a voicemail. They text the next name on the list, and you never hear back.

We put an AI receptionist on that number instead. It answers in seconds, gets the job details, and drops them straight in your inbox.

Want me to build one on your own number, or is this not a problem worth fixing right now?

{{sender_name}}$tpl$,
      false
    ),
    (
      'T2 no audit demo link',
      2::smallint,
      $subj$Re: {{company_name}} and the calls that ring out$subj$,
      $tpl$Following up on my note.

I built one on {{company_name}}'s details, so you can hear it rather than take my word for it:

{{demo_url}}

Call it, text it, try to trip it up. Every call it picks up is one that would otherwise have gone somewhere else.

Do you want it pointed at your real number, or would you rather leave it as a demo?

{{sender_name}}$tpl$,
      true
    ),
    (
      'T3 no audit still live',
      3::smallint,
      $subj$Re: {{company_name}} and the calls that ring out$subj$,
      $tpl$The demo I built for {{company_name}} is still up:

{{demo_url}}

It has been answering every test call in under two seconds. The ones that ring out at your end while the crew is on a job are the jobs you are losing to whoever picks up first.

Should I switch it on for your number, or close the file?

{{sender_name}}$tpl$,
      true
    ),
    (
      'T4 no audit closing',
      4::smallint,
      $subj$Re: {{company_name}} and the calls that ring out$subj$,
      $tpl$Last one from me.

The offer stands: an AI receptionist on {{company_name}}'s number, answering what currently rings out. Every one of those calls is a job walking away to whoever picked up first.

Should I leave this open, or close it out?

{{sender_name}}$tpl$,
      false
    )
) as seed(name, step_number, subject, body, requires_demo)
on conflict (org_id, name) do nothing;

-- ---------------------------------------------------------------------------
-- 4. leads.angle_type is what selects between them
-- ---------------------------------------------------------------------------
-- The column has existed since 0003 and nothing has ever written it. The audit
-- screen now sets it, but leads audited BEFORE this migration would keep
-- selecting the generic copy despite having evidence to quote. Backfill from
-- the evidence that already exists.

update leads l
   set angle_type = e.angle_type
  from (
    select distinct on (lead_id) lead_id, angle_type
      from lead_evidence
     order by lead_id, audited_at desc
  ) e
 where e.lead_id = l.id
   and l.angle_type is null;

comment on column leads.angle_type is
  'Which outreach angle this lead is being worked on, and therefore which '
  'template variant it gets. Stamped by the audit screen. NULL means nobody '
  'audited it, which selects the generic copy rather than blocking the send.';
