-- The two new type values, in their own file.
--
-- Same reason as 0028: ALTER TYPE ... ADD VALUE cannot be used in the same
-- transaction that creates it, and every statement in 0036 that mentions
-- 'stage_changed' — the derive function's WHERE clause most of all — would be
-- parsed inside that transaction. Splitting the file is the whole fix.
--
-- `create type` has no such restriction, so pipeline_stage rides along: nothing
-- here USES either value.

alter type lead_event_type add value if not exists 'stage_changed';

-- Where the human thinks the deal is, as opposed to what the machine did.
--
-- Deliberately stops before the close. Won / lost / do-not-contact are already
-- leads.terminal_outcome, which close_lead() owns and which beats every event
-- in app.lead_status_from_events. Repeating them here would give "did we win"
-- two answers that could disagree.
create type pipeline_stage as enum (
  'prospect',   -- no reply yet. The outbound machine still owns this lead.
  'engaged',    -- they answered and it was not a bounce or an unsubscribe.
  'meeting',    -- a call is booked.
  'proposal',   -- pricing is out and we are waiting on a decision.
  'nurture'     -- not now. Parked deliberately, so it stops reading as active.
);
