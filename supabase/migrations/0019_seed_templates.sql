-- The four touches, as drafts.
--
-- The templates table has been empty since 0014, which means the planner has
-- been skipping every eligible lead with skipped_no_template. These four exist
-- so the sequence has something to run, and they are seeded INACTIVE on
-- purpose: this is the copy that goes to strangers in the operator's name, and
-- nobody but the operator gets to decide it is ready. Activating is one toggle
-- on the templates screen, and the lint trigger runs at that moment.
--
-- Three constraints shaped the wording, all of them checkable:
--
--   * Every one lints clean today, so activation cannot fail on copy the
--     migration wrote. tests/unit/seededTemplates.test.ts runs these exact
--     strings through lib/templates/lint.ts to keep that true.
--   * Only variables that survive a null. company_name comes from the Maps
--     scrape and the audit fields are written by the audit screen before a lead
--     can reach `audited` at all. first_name is deliberately NOT used: it is
--     null on plenty of scraped rows, and renderTemplate refuses to send a
--     template whose variable is hollow rather than greeting nobody. Add it
--     once the data supports it.
--   * T1 does not claim a demo exists. The build order puts demos at
--     qualification, but nothing is calling the ingest API yet, so a T1 that
--     required one would block the entire first cohort. T2 and T3 carry
--     requires_demo, which is what makes the planner wait for it.
--
-- Follow-up subjects are the T1 subject with Re: in front. The dispatcher
-- threads on Gmail's threadId and References either way; the prefix is for the
-- clients that also thread on subject, and for the prospect who reads it.

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
      'T1 audit callback',
      1::smallint,
      $subj$however {{company_name}} answered on {{audit_day_local}}$subj$,
      $tpl$I texted {{company_name}} on {{audit_day_local}} at {{audit_time_local}}, the way somebody with a job to book would. Result: {{response_delay}}.

That is not a knock on your crew. It is what happens when the phone goes while everyone is on a roof or under a sink. The customer does not wait though. They text the next name on the list, and you never hear back.

We put an AI receptionist on that number instead. It answers in seconds, gets the job details, and drops them straight in your inbox.

Want me to build one on your own number, or is this not a problem worth fixing right now?

{{sender_name}}$tpl$,
      false
    ),
    (
      'T2 demo link',
      2::smallint,
      $subj$Re: however {{company_name}} answered on {{audit_day_local}}$subj$,
      $tpl$Following up on the text I sent on {{audit_day_local}}.

I went ahead and built it. This is a live receptionist for {{company_name}}, answering the way yours would if anybody were free:

{{demo_url}}

Text it a job the way a customer would. It comes back in seconds, at 2am, on a Sunday, while the calls you are missing right now are going to voicemail.

Do you want this pointed at your real number, or is the demo enough to judge it on?

{{sender_name}}$tpl$,
      true
    ),
    (
      'T3 still live',
      3::smallint,
      $subj$Re: however {{company_name}} answered on {{audit_day_local}}$subj$,
      $tpl$Short one. The receptionist I built for {{company_name}} is still up:

{{demo_url}}

Every week it sits there is another week of after hours calls going to voicemail and those jobs going somewhere else. Pointing it at your real number takes about twenty minutes, and I do that part.

Should I get it live this week, or park it until things slow down?

{{sender_name}}$tpl$,
      true
    ),
    (
      'T4 closing the file',
      4::smallint,
      $subj$Re: however {{company_name}} answered on {{audit_day_local}}$subj$,
      $tpl$Last one from me.

I texted {{company_name}} on {{audit_day_local}} at {{audit_time_local}}. Result: {{response_delay}}. That is the entire pitch. Every unanswered text is somebody who went ahead and booked with someone else.

I will close the file today unless I hear otherwise. No hard feelings either way.

Want me to leave the door open for a month, or take {{company_name}} off my list?

{{sender_name}}$tpl$,
      false
    )
) as seed(name, step_number, subject, body, requires_demo)
on conflict (org_id, name) do nothing;
