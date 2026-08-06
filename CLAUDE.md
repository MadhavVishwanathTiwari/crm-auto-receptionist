# Outreach Ops — working notes

Internal two-user app that owns AutoReceptionist's cold outbound pipeline:
CSV ingest → dedupe → claim → audit → schedule → send → reply. Replaces an
`outreach_management` Google Sheet. Two operators, ~40 sends/day.

Full build plan, capacity analysis, and phasing:
`C:\Users\madha\.claude\plans\build-brief-v2-indexed-lerdorf.md`

## Non-negotiables

1. **Every DB change is a migration file.** Never edit the Supabase dashboard.
   `supabase/migrations/NNNN_name.sql`, applied by `npm run db:reset`.
2. **The service-role key is server-only.** Allowed in exactly these routes:
   - `app/api/cron/**`
   - `app/api/v1/demos/**` (external POST, no user session exists)
   - `app/api/auth/google/callback` (writes `mailbox_secrets`)

   Everywhere else uses the cookie-bound RLS client. Enforced by an ESLint rule
   and `npm run check:bundle`.
3. **Status is derived, never typed.** The app inserts into `lead_events`; a
   trigger recomputes `leads.status`. `leads_guard_protected_columns` rejects
   direct writes to `status`, `claimed_by`, and the demo URLs. Terminal outcomes
   go in as a `closed` event, so even those pass through the log.
4. **`work_email` is the only send target.** `email_1/2/3` and `likely_email`
   are imported for reference and must never be sent to.
5. **All scheduling math is prospect-local.** Nobody sees UTC or IST. The UI
   shows the operator's local time with prospect-local alongside.
6. **Never guess a timezone.** A lead with no resolvable IANA zone is flagged
   for manual assignment and is never scheduled. No state→timezone table — it
   silently corrupts FL, TX, TN, ID, OR, KS, NE, ND, SD, MI, IN, KY and Arizona.

## Things that will bite you

- **A PostgREST UPDATE denied by RLS returns 204 with zero rows, not an error.**
  Negative write tests must re-read as a privileged client and assert the value
  is unchanged. Asserting `error !== null` passes vacuously against a completely
  broken policy. Client code must `.select()` after every write and treat `[]`
  as a denial.
- **`app.current_org_id()` must be `SECURITY DEFINER`.** As `SECURITY INVOKER`
  the RLS policy on `org_members` re-enters itself while being evaluated →
  infinite recursion. This is the classic Supabase multi-tenant lockup.
- **Supabase Realtime broadcasts tables, not views.** Anything the grid needs
  pushed live must be a real column on a published table. Derived grid columns
  recompute client-side from the pushed row via a shared `deriveRowComputed`.
- **Mailbox caps count in the mailbox's timezone, not the prospect's.** A 20/day
  cap is a Gmail reputation limit on the sending account; it resets in the
  operator's day. Collapsing the two silently over-sends.
- **`geo-tz` ships ~70 MB of boundary data.** Import it only in the timezone
  resolution route so Next traces it into that one lambda. It is in
  `serverExternalPackages`; bundling it breaks its runtime data paths.
- **Instantly warmup mail lives in the same mailboxes and must not be touched.**
  We request `gmail.send` + `gmail.readonly` and deliberately never
  `gmail.modify`, so the app is structurally incapable of archiving, labelling
  or marking it read. Instantly needs those messages sitting in the inbox.

## Copy constraints (enforced by `lib/templates/lint.ts`)

No em dashes. Loss-framed CTA. Binary-choice close. One ask per email.
A template cannot be set `is_active` unless it lints clean.

## Commands

```bash
npm run db:start     # local Supabase stack (required for integration tests)
npm run db:reset     # re-apply every migration from scratch + seed
npm run db:types     # regenerate types/db.ts
npm run verify       # typecheck + lint + test
```

## Related repos

- `D:\Portfolio\ar-lead-finder` — Apify scraper + Clay enrichment. Source of
  leads. Separate Supabase project. Absorbed in Phase 3; its Apify token-pool
  rotation is the piece worth keeping.
- `D:\Portfolio\Auto-Receptionist-Website\Auto-Receptionist` — builds sandbox
  demos. Has **no** `place_id`; its slugs derive from the website hostname, and
  nine legacy demos use hand-picked slugs that don't match their domain. Join on
  normalized domain. It currently reads `status == 'first_touch'` from the
  Google Sheet, so `GET /api/v1/demos/pending` must ship before that sheet is
  retired.
