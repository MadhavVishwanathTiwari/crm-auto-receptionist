# Outreach Ops — working notes

Internal two-user app that owns AutoReceptionist's cold outbound pipeline:
CSV ingest → dedupe → claim → audit → **write** → schedule → send → reply.
Replaces an `outreach_management` Google Sheet. Two operators, ~40 sends/day.

**What this app is for, in one line:** an operator writes each email by hand,
and the app decides the instant it leaves. That is the difference from Instantly
(one piece of copy to a thousand people) and from a mail client (you write it
*and* you pick send o'clock). `/write` is that screen and it is the front door;
the template sequencer underneath it is the automated fallback, not the product.

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

Two things write into `scheduled_sends`, and only the first line differs:

```
/write → queue_composed_send() → 'planned'   a person's words, a chosen slot
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

## Writing the email yourself (`/write`)

The screen the app exists for. Three panes: the leads you have claimed, a
composer, and everything about that business worth writing about. You type an
email, press Ctrl+Enter, and the next lead loads. You never pick a time.

A composed send is **not a second pipeline**. It is a `scheduled_sends` row like
any other, so suppression, mailbox caps, threading, stall reaping, the reply
halt and the `dry_run` kill switch are all written once and apply to it
unchanged. The only difference is where the words came from.

- **`composed_body` beats `template_id` in the dispatcher, and skips rendering
  entirely.** No substitution pass means no missing-variable skip, which is what
  makes hand-writing the safe path for a lead whose import is thin. The cost is
  that a leftover `{{company_name}}` would go out with the braces showing, so
  both `WriteClient` and `queueWrittenEmail()` refuse a body containing one.
- **The slot is computed in TypeScript and passed into the RPC**, because
  `lib/scheduler/slots.ts` owns the holiday table, the DST-correct wall clock
  and the business-day walk, and none of that is worth a second implementation
  in plpgsql. `queue_composed_send()` enforces what must hold regardless of who
  did the arithmetic: the org, the claim, the timezone, the suppression list,
  the step, and that the slot is in the future.
- **`lib/scheduler/book.ts` is the single copy of the capacity arithmetic.**
  The planner and the composer both use `buildCapacity`/`pickMailbox`/`reserve`.
  Two copies would eventually disagree about whether a mailbox had room, and the
  disagreement shows up as over-sending rather than as an error.
- **The worklist previews a slot per lead, reserving as it walks.** So the
  twentieth lead does not claim the same seat as the first, and what you see is
  what would happen if you wrote to all of them in order. The action re-books
  authoritatively and returns the real slot, which is what the confirmation
  line shows.
- **Composing REPLACES a `planned`/`blocked` row at the same step** rather than
  erroring on `scheduled_sends_lead_step_live`; it refuses a `claimed`,
  `sending` or `sent` one, because by then the dispatcher may be inside the
  Gmail call.
- **`revise_composed_send()` never re-times.** Fixing a typo three minutes
  before the slot must not silently rebook it to tomorrow morning, which is
  exactly what "cancel and re-queue" would do.
- **The planner re-times a written send whose slot passed and keeps the words.**
  `plan-sends` skips the template lookup and the demo gate for a row carrying
  `composed_body`; requiring a template there would strand a hand-written email
  forever the moment its step had no active one.

## An audit is a choice, not a precondition

Two template sets exist per step, and `templateFor()` picks between them on
`leads.angle_type`:

- **`soft_text_audit`** (`0019`) quotes the callback back. Every variable in it
  comes from `lead_evidence`, so it can only go to a lead somebody audited. The
  audit screen stamps the angle on the lead, which is what selects it.
- **`null`** (`0022`) quotes nothing and asks only for `company_name`,
  `demo_url` and `sender_name`. It is the fallback, so a lead nobody audited
  gets it.

What makes an unaudited lead sendable **to the planner** is a `queued` event,
written per lead by "Send without an audit" on the lead drawer. `queued`
outranks `audited` in `app.lead_status_from_events` and the planner has accepted
both since `0015`, so no gate was widened: a merely *claimed* lead is still not
sendable by the planner, because "this one is not worth an audit" is a decision
somebody has to make.

`/write` is the third way through, and it is looser on purpose: any claimed,
qualified, zoned lead can be written to, because **writing the email is that
decision**. Requiring the operator to press "send without an audit" first would
be asking them to declare that they are about to do the thing they are doing.
`queue_composed_send()` writes the `queued` event itself, which is what lets the
planner pick the follow-ups up afterwards.

Adding a variable to the generic set is how you break it. `renderTemplate()`
treats a null variable as missing and the dispatcher skips the send, so `city`,
`industry` and `first_name` stay out until the import fills them reliably.
`tests/integration/unaudited-sends.test.ts` asserts the selection both ways.

## Copy constraints (enforced by `lib/templates/lint.ts`)

No em dashes. Loss-framed CTA. Binary-choice close. One ask per email. Only
variables that exist. A template cannot be set `is_active` unless it lints
clean — enforced by `app.template_lint()` behind a trigger, with the TypeScript
copy kept honest by `tests/integration/template-lint-parity.test.ts`.

**These bind templates, not hand-written email.** A person writing to one
business can see things a regex cannot, and a linter that refused to send it
would make the composer worse than a Gmail tab. The rules are printed on the
`/write` context panel as guidance instead.

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
2. **An active T1 template** — for the *automated* touches only. `0019` seeds
   the audit set, `0022` the generic set, both as drafts. T2 and T3 carry
   `requires_demo`, so they wait for the demo ingest; T1 and T4 do not. `/write`
   needs none of this: an email you type carries its own words, and the
   templates show up there as starters you can fill in and rewrite.
3. **A lead that is ready.** For the planner: claimed, qualified, zoned, not
   suppressed, and either audited or explicitly queued without one. `/queue`
   groups every lead by which of those it is missing. For `/write`: claimed by
   you, qualified, zoned, with a work email, and not suppressed.
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
