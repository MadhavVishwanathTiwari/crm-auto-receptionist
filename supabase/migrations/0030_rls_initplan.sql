-- Make every RLS predicate run once per statement instead of once per row.
--
-- Every policy in this database is written `org_id = app.current_org_id()`.
-- That function is `stable`, which is correct, but it is also `security
-- definer` -- and Postgres never inlines a security definer SQL function,
-- because inlining it would evaluate its body in the caller's security context
-- and defeat the point. So it stays a real function call in the qual, and a
-- qual is evaluated per tuple: the /leads grid scans 5000 rows and calls it
-- 5000 times, each call an index lookup on org_members.
--
-- Wrapping the call in a scalar subquery turns it into an InitPlan. It has no
-- correlation to the row being tested, so the planner evaluates it once before
-- the scan starts and compares 5000 rows against the cached scalar. Same for
-- auth.uid() and app.is_admin().
--
-- NOTHING HERE CHANGES WHO CAN SEE OR WRITE WHAT. Every predicate is the same
-- boolean expression with the same operands; only when the operands are
-- computed moves. The integration suite is what proves that, and per CLAUDE.md
-- its negative write tests re-read as a privileged client rather than asserting
-- `error !== null`, so a policy accidentally widened here fails rather than
-- passing vacuously.
--
-- `alter policy` rather than drop-and-create: the policy keeps its name, its
-- command and its `to authenticated` grant, so there is no window in the
-- transaction where a table is readable by a role it should not be.
--
-- The whole set is rewritten, not just the tables big enough to notice. A
-- half-converted file is worse than an unconverted one, because the next
-- policy gets written by copying whichever neighbour the author happened to
-- look at.

-- ---------------------------------------------------------------------------
-- 0002 -- orgs, membership, settings
-- ---------------------------------------------------------------------------

alter policy orgs_select on orgs
  using (id = (select app.current_org_id()));

alter policy orgs_update on orgs
  using (id = (select app.current_org_id()) and (select app.is_admin()))
  with check (id = (select app.current_org_id()) and (select app.is_admin()));

alter policy org_members_select on org_members
  using (org_id = (select app.current_org_id()));

alter policy org_members_write on org_members
  using (org_id = (select app.current_org_id()) and (select app.is_admin()))
  with check (org_id = (select app.current_org_id()) and (select app.is_admin()));

alter policy org_settings_select on org_settings
  using (org_id = (select app.current_org_id()));

alter policy org_settings_update on org_settings
  using (org_id = (select app.current_org_id()) and (select app.is_admin()))
  with check (org_id = (select app.current_org_id()) and (select app.is_admin()));

-- ---------------------------------------------------------------------------
-- 0005 -- leads, events, evidence, suppressions
--
-- leads_select is the one that pays for this migration on its own: it is the
-- qual on the 5000-row grid query and on the queue's classification pass.
-- ---------------------------------------------------------------------------

alter policy leads_select on leads
  using (org_id = (select app.current_org_id()));

alter policy leads_insert on leads
  with check (org_id = (select app.current_org_id()));

alter policy leads_update on leads
  using (
    org_id = (select app.current_org_id())
    and archived_at is null
    and (
      claimed_by is null
      or claimed_by = (select auth.uid())
      or (select app.is_admin())
    )
  )
  with check (
    org_id = (select app.current_org_id())
    and (
      claimed_by is null
      or claimed_by = (select auth.uid())
      or (select app.is_admin())
    )
  );

alter policy lead_events_select on lead_events
  using (org_id = (select app.current_org_id()));

alter policy lead_events_insert on lead_events
  with check (
    org_id = (select app.current_org_id())
    and actor_id = (select auth.uid())
    and type in ('audited', 'note', 'manual_override')
    and exists (
      select 1 from leads l
       where l.id = lead_id and l.org_id = (select app.current_org_id())
    )
  );

alter policy lead_evidence_select on lead_evidence
  using (org_id = (select app.current_org_id()));

alter policy lead_evidence_insert on lead_evidence
  with check (
    org_id = (select app.current_org_id())
    and created_by = (select auth.uid())
    and exists (
      select 1 from leads l
       where l.id = lead_id
         and l.org_id = (select app.current_org_id())
         and (
           l.claimed_by is null
           or l.claimed_by = (select auth.uid())
           or (select app.is_admin())
         )
    )
  );

alter policy lead_evidence_update on lead_evidence
  using (
    org_id = (select app.current_org_id())
    and (created_by = (select auth.uid()) or (select app.is_admin()))
  )
  with check (org_id = (select app.current_org_id()));

alter policy lead_evidence_delete on lead_evidence
  using (
    org_id = (select app.current_org_id())
    and (created_by = (select auth.uid()) or (select app.is_admin()))
  );

alter policy suppressions_select on suppressions
  using (org_id = (select app.current_org_id()));

alter policy suppressions_insert on suppressions
  with check (
    org_id = (select app.current_org_id())
    and created_by = (select auth.uid())
  );

alter policy suppressions_delete on suppressions
  using (org_id = (select app.current_org_id()) and (select app.is_admin()));

-- ---------------------------------------------------------------------------
-- 0007 -- import staging
--
-- import_rows is the other table that gets scanned in bulk: a CSV commit writes
-- and re-reads one row per line of the file.
-- ---------------------------------------------------------------------------

alter policy imports_select on imports
  using (org_id = (select app.current_org_id()));

alter policy imports_insert on imports
  with check (
    org_id = (select app.current_org_id())
    and created_by = (select auth.uid())
  );

alter policy imports_update on imports
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));

alter policy import_rows_select on import_rows
  using (org_id = (select app.current_org_id()));

alter policy import_rows_insert on import_rows
  with check (org_id = (select app.current_org_id()));

alter policy import_rows_update on import_rows
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));

alter policy dedupe_reviews_select on dedupe_reviews
  using (org_id = (select app.current_org_id()));

alter policy dedupe_reviews_insert on dedupe_reviews
  with check (org_id = (select app.current_org_id()));

alter policy dedupe_reviews_update on dedupe_reviews
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));

-- ---------------------------------------------------------------------------
-- 0010 -- the evidence bucket
--
-- The drawer signs a batch of screenshot URLs in one call, so this qual is
-- evaluated once per object in the batch rather than once overall.
-- ---------------------------------------------------------------------------

alter policy lead_evidence_objects_select on storage.objects
  using (
    bucket_id = 'lead-evidence'
    and (storage.foldername(name))[1] = (select app.current_org_id())::text
  );

alter policy lead_evidence_objects_insert on storage.objects
  with check (
    bucket_id = 'lead-evidence'
    and (storage.foldername(name))[1] = (select app.current_org_id())::text
  );

alter policy lead_evidence_objects_delete on storage.objects
  using (
    bucket_id = 'lead-evidence'
    and (storage.foldername(name))[1] = (select app.current_org_id())::text
    and (select app.is_admin())
  );

-- ---------------------------------------------------------------------------
-- 0013 -- mailboxes and alerts
-- ---------------------------------------------------------------------------

alter policy mailboxes_select on mailboxes
  using (org_id = (select app.current_org_id()));

alter policy mailboxes_update on mailboxes
  using (
    org_id = (select app.current_org_id())
    and (user_id = (select auth.uid()) or (select app.is_admin()))
  )
  with check (
    org_id = (select app.current_org_id())
    and (user_id = (select auth.uid()) or (select app.is_admin()))
  );

alter policy mailboxes_delete on mailboxes
  using (org_id = (select app.current_org_id()) and (select app.is_admin()));

alter policy mailbox_events_select on mailbox_events
  using (org_id = (select app.current_org_id()));

alter policy alerts_select on alerts
  using (org_id = (select app.current_org_id()));

alter policy alerts_update on alerts
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));

-- ---------------------------------------------------------------------------
-- 0014 -- templates
-- ---------------------------------------------------------------------------

alter policy templates_select on templates
  using (org_id = (select app.current_org_id()));

alter policy templates_insert on templates
  with check (
    org_id = (select app.current_org_id())
    and created_by = (select auth.uid())
  );

alter policy templates_update on templates
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));

alter policy templates_delete on templates
  using (org_id = (select app.current_org_id()) and (select app.is_admin()));

-- ---------------------------------------------------------------------------
-- 0015 -- scheduled sends
--
-- /write reads every live send in the org on every render and again on every
-- Ctrl+Enter, so this one is on the hot path of the screen the app exists for.
-- ---------------------------------------------------------------------------

alter policy scheduled_sends_select on scheduled_sends
  using (org_id = (select app.current_org_id()));
