-- Adds 'demo_failed' to lead_event_type: the Auto-Receptionist builder tried to
-- build this lead's demo and refused to publish it.
--
-- Until now a refused build left no trace here at all. The builder read its
-- work from the outreach sheet, a failure was a log line in a GitHub Action,
-- and the only symptom in this app was T2 waiting on demo_ready_at forever
-- with nobody able to say why. POST /api/v1/demos now records a failure as
-- this event, and GET /api/v1/demos/pending reads it back as a cooldown so the
-- same unbuildable site does not take the nightly budget every night.
--
-- It changes no status. app.lead_status_from_events ranks every type it does
-- not name as 0, and a rank-0 event never advances or regresses a lead, which
-- is exactly right: a failed build is a fact about the demo, not the pipeline.
--
-- Its own file, and nothing uses the value here, because ALTER TYPE ... ADD
-- VALUE cannot be used by a later statement in the same transaction.

alter type lead_event_type add value if not exists 'demo_failed';
