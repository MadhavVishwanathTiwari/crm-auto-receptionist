-- Alerts have to arrive, not be discovered.
--
-- poll-replies has been writing reply, bounce and unsubscribe rows into alerts
-- since 0013, and until now nothing read them. The alerts screen does, and a
-- screen that only updates on refresh is a screen nobody leaves open, which
-- turns a reply into something you find rather than something you get.
--
-- REPLICA IDENTITY FULL is not optional here, for the reason 0012 records in
-- full: Realtime evaluates the subscriber's RLS policy against the changed row
-- before forwarding it, and with the default identity the WAL record carries
-- only the primary key. There is nothing to evaluate alerts_select against, so
-- every change is dropped while the subscription still reports SUBSCRIBED.
--
-- The cost that argued against FULL on `leads` does not apply: alerts has no
-- tsvector, is written a few times a day, and is never bulk-updated.

alter table public.alerts replica identity full;
alter publication supabase_realtime add table public.alerts;
