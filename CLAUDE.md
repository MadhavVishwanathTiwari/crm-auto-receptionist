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

## The send path (Phase 2)

```
plan-sends  → scheduled_sends('planned')   prospect-local slot, mailbox assigned
claim_due_sends()                          caps in the MAILBOX zone, dry_run gate
dispatch-sends → Gmail → 'sent'            suppressions re-checked here, not at plan time
poll-replies → replied/bounced/unsubscribed  halts the sequence via lead_events
```

- **The dispatcher marks `sending` BEFORE calling Gmail.** A function killed
  mid-request then leaves a visibly stuck row rather than a claimable one.
  `reap_stalled_sends()` fails those; it never retries them, because we cannot
  know whether Gmail accepted the message and a wrong guess is a second email.
- **`mark_send_sent()` is one transaction**: the row, the `sent` event carrying
  Gmail's message id as its `dedupe_token`, and the mailbox stamp.
- **`claim_due_sends()` takes a TRANSACTION-scoped advisory lock per mailbox**
  (`pg_advisory_xact_lock`), not a session-scoped one. It is reached over
  PostgREST, which runs each RPC in its own transaction on a pooled connection
  it then hands to the next request: a session lock would outlive the request
  and leak permanently on any error path between lock and unlock.
- **A lead with no timezone is refused by a trigger**, not only by the planner's
  WHERE clause. That guard binds the service role too, because every writer of
  `scheduled_sends` is a machine.
- **`mailboxes.display_name` is null until an operator sets it.** It is the From
  header and `{{sender_name}}`; a template using that variable refuses to send
  rather than putting an email address where a human name belongs.

## Copy constraints (enforced by `lib/templates/lint.ts`)

No em dashes. Loss-framed CTA. Binary-choice close. One ask per email. Only
variables that exist. A template cannot be set `is_active` unless it lints
clean — enforced by `app.template_lint()` behind a trigger, with the TypeScript
copy kept honest by `tests/integration/template-lint-parity.test.ts`.

## Commands

```bash
npm run db:push      # apply pending migrations to the CLOUD project (additive)
npm run db:start     # local Supabase stack (needs Docker)
npm run db:reset     # DROPS AND RECREATES the local database, then re-seeds
npm run db:types     # regenerate types/db.ts (needs Docker)
npm run verify       # typecheck + lint + test
```

The four cron routes take `POST` with `Authorization: Bearer $CRON_SECRET`, and
each accepts an optional `?org=<uuid>` to scope a run to one org. Cadence, as
scheduled by `0020`: `resolve-timezones` hourly, `plan-sends` every 15 minutes,
`dispatch-sends` every 5 (it takes 20 per run by default, `?limit=` to change),
`poll-replies` every 10.

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" $SITE/api/cron/plan-sends
```

**pg_cron drives them, not Vercel cron** — Hobby permits one invocation a day,
and the dispatcher needs twelve an hour. `app.call_job()` reads the URL and the
bearer out of Vault at call time, so rotating `CRON_SECRET` is one update rather
than four reschedules, and `cron.job.command` never holds a secret. Nothing is
scheduled until both Vault secrets exist; until then the buttons on `/settings`
are the scheduler, and they call the same routes with the same check.

## Going live

The state of these is on `/settings`, which lists exactly what is still between
you and the first email. In the order they block:

1. **A mailbox, with a display name.** `mailboxes.display_name` is the From
   header and `{{sender_name}}`; a template using that variable refuses to send
   rather than putting an email address where a human name belongs.
2. **An active T1 template.** `0019` seeds all four as INACTIVE drafts. They
   lint clean, so activating is one toggle, but the copy goes out in your name
   and nobody but you gets to decide it is ready. T2 and T3 carry
   `requires_demo`, so they wait for the demo ingest; T1 and T4 do not.
3. **A lead that is ready**: claimed, audited, qualified, zoned, not suppressed.
   `/queue` groups every lead by which of those it is missing.
4. **Dry run off.** `org_settings.dry_run` is enforced inside
   `claim_due_sends()`, so while it is true the app is structurally incapable of
   sending. This is the last switch, not the first.

Then, to stop pressing buttons:

```sql
select vault.create_secret('https://your-deployment', 'app_base_url');
select vault.create_secret('<CRON_SECRET>', 'cron_secret');
select app.enable_background_jobs();
```

`public.background_jobs_status()` is what `/settings` reads back, and
`app.disable_background_jobs()` stops everything without touching a schedule by
hand.

## The demo contract

`GET /api/v1/demos/pending` and `POST /api/v1/demos`, both bearing
`AR_INGEST_SECRET`. Together they replace the `outreach_management` sheet as the
Auto-Receptionist repo's work queue and write-back target.

- **`/pending` returns qualified leads with a website and no demo yet**, oldest
  first, and drops suppressed domains. It does NOT require the first touch to
  have gone out: demos are built at qualification so T1's copy is true and T2 is
  not racing a build.
- **`POST` joins on normalized domain**, `place_id` first when present and
  `lead_id` first when the caller echoes one back. A payload matching no lead
  raises an `orphan_demo` alert rather than being dropped, because somebody paid
  a model to build it.
- **The `timezone` that repo reports is accepted and never applied.** It derives
  zones from state and city, which is the mapping non-negotiable 6 forbids. It
  is kept in the `demo_ready` event payload for comparison only.
- **`record_demo()` is the only writer of the demo columns.** The guard in
  `0004` binds the service role too, so the route cannot UPDATE the row itself.

## Reply alerts

`poll-replies` writes `alerts` rows; `/alerts` reads them live over Realtime
(`0018` publishes the table, with `replica identity full` for the reason `0012`
records). Set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_IDS`, or `NTFY_TOPIC`, and
each newly inserted alert also goes to a phone. Unconfigured is a no-op, and a
push failure never fails the poll: only a genuinely new row notifies, which is
what stops an overlapping history page buzzing twice for one reply.

## Where the tests run

`tests/setup/target.ts` picks a target: **local** if the stack is up, **cloud**
otherwise, forced by `TEST_TARGET=local|cloud`. It prints a warning whenever it
lands on cloud, because a suite that silently changes which database it asserts
against is worse than one that fails.

Local is the preferred home. Not because RLS behaves differently — it doesn't —
but because `db:reset` drops the database, and that command must never learn to
point at the project holding real leads. It is deliberately left with no
`--db-url`; only `db:push`, which is additive, targets cloud.

Connection gotchas, both discovered the hard way:

- **`SUPABASE_DIRECT_URL` (`db.<ref>.supabase.co`) does not resolve** on this
  network. Newer projects make it IPv6-only. Use `SUPABASE_POOLER_URL`.
- **Use the SESSION pooler on 5432, not the TRANSACTION pooler on 6543.** The
  transaction pooler breaks prepared statements, which is what `db:push` and
  the reconcile job speak. (`claim_due_sends()` no longer depends on this: it
  holds a transaction-scoped advisory lock, which is correct over PostgREST
  either way. See the send-path notes above.)
- **`supabase gen types` and `db diff` shell out to Docker** even with a
  `--db-url`. Only `db push` works without it.

## Related repos

- `D:\Portfolio\ar-lead-finder` — Apify scraper + Clay enrichment. Source of
  leads. Separate Supabase project. Absorbed in Phase 3; its Apify token-pool
  rotation is the piece worth keeping.
- `D:\Portfolio\Auto-Receptionist-Website\Auto-Receptionist` — builds sandbox
  demos. Has **no** `place_id`; its slugs derive from the website hostname, and
  nine legacy demos use hand-picked slugs that don't match their domain. Join on
  normalized domain. It reads `status == 'first_touch'` from the Google Sheet in
  `build-from-sheet.mjs`; `GET /api/v1/demos/pending` is the replacement and is
  live, so that script can be repointed and the sheet retired. Its write-back of
  `demo_txt` becomes a `POST /api/v1/demos` per built slug.
