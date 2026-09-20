-- The two enum values the AI replier needs, alone in their own file.
--
-- ALTER TYPE ... ADD VALUE cannot be used by a later statement in the same
-- transaction, and 0053 writes both of these into function bodies. 0051 split
-- its file for exactly this reason.
--
-- `alert_kind.ai_reply` is one kind, not two. A drafted reply and a sent one
-- are the same event from the operator's side -- the assistant answered this
-- prospect, here is what it said -- and the message itself says which.
--
-- `lead_event_type.ai_replied` is deliberately NOT `note`. A note is something
-- a person typed, rendered identically in the drawer timeline, and a cron row
-- with actor_id null would be indistinguishable from one. It ranks 0 in
-- app.lead_status_from_events like `note` does, so it moves no status: a reply
-- we wrote is not a fact about what the prospect did.

alter type alert_kind      add value if not exists 'ai_reply';
alter type lead_event_type add value if not exists 'ai_replied';
