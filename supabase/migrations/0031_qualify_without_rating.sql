-- 0031 — qualification stops asking for a star rating.
--
-- 0003 defined `leads.is_qualified` as `rating >= 3.5 and a work email`. The
-- rating half is gone: a lead with no rating at all, or a low one, is now
-- qualified as long as there is something to send to. What remains is not a
-- quality bar, it is the send target, which is the half that was ever load
-- bearing — an unqualified lead was never "bad", it was "unreachable".
--
-- Two things this unblocks immediately:
--   * The 333 sheet leads from 0027. The sheet carries no rating column, so
--     every one of them sat at is_qualified = false and neither the planner
--     nor /write would touch them. They now clear the gate on their work
--     email alone, which is what 0027's closing note was waiting on.
--   * Any import whose source has no rating (Clay exports, hand-built lists).
--
-- The column stays generated and stays hardcoded, for 0003's reason: a
-- generated column cannot read org_settings, and one source of truth beats a
-- config knob that silently disagrees with the column.
--
-- A generated expression cannot be altered in place, so the column is dropped
-- and re-added. Nothing depends on it structurally — no index, no view, no RLS
-- policy. `claim_leads()` (0005) reads it inside a plpgsql body, which is
-- re-planned per call, so it picks up the new definition with no change here.
-- The column is `stored`, so re-adding it rewrites the table; at a few thousand
-- rows that is milliseconds.

alter table public.leads drop column is_qualified;

alter table public.leads
  add column is_qualified boolean generated always as (
    work_email is not null and btrim(work_email) <> ''
  ) stored;

comment on column public.leads.is_qualified is
  'Generated: the lead has a work_email to send to. No rating floor — removed '
  'in 0031, because a missing rating means an import without the column, not a '
  'bad business.';
