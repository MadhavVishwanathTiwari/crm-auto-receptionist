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
4. **`work_email` is the only address, not merely the only send target.**
   `email_1/2/3` and `likely_email` were dropped in `0034`. They imported "for
   reference", nothing ever read them, and what they held was mostly webmaster
   addresses, a site builder's support desk and placeholders left in an unedited
   template. A column whose whole contract is that nobody may use it is a column
   that exists to be used by mistake. `leads.raw` still has the original row if a
   question ever needs one. A second address comes back as a feature with a
   reason to read it, not as spare columns.
5. **All scheduling math is prospect-local.** Nobody sees UTC or IST. The UI
   shows the operator's local time with prospect-local alongside.
6. **Never guess a timezone.** A lead with no resolvable IANA zone is flagged
   for manual assignment and is never scheduled. No state→timezone table — it
   silently corrupts FL, TX, TN, ID, OR, KS, NE, ND, SD, MI, IN, KY and Arizona.

   `lib/timezone/places.ts` is the one narrow exception and it is not that
   table. Coordinates win whenever they exist. Failing those, a state lying
   entirely inside one zone (CT, GA, CA, …) resolves from the state, because
   that is a fact rather than a majority; every state a boundary crosses
   resolves from a **named city** or not at all, and so does Arizona, whose
   Navajo Nation towns are deliberately absent so they stay manual. A bare city
   with no state resolves only if the name is unique in the table and not on
   the repeats-across-America list — "Glendale" alone never resolves. Adding a
   city is a one-line change; adding a *state* to the single-zone list is the
   thing to be suspicious of.
7. **An email leaves from its own operator's mailbox.** Never the emptiest one.
   `lib/scheduler/routing.ts` narrows the candidate list before `bookSlot` sees
   it, and `queue_composed_send()` refuses anything else. The one exception is a
   lead whose sequence already started somewhere: that is a Gmail requirement,
   not a preference. See "Whose mailbox" below.

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

## What makes this app fast, and what made it slow

Nothing here does heavy work: two operators, a few thousand leads, one
`bookSlot()` pass over a worklist. Every second this app has ever lost was a
**network round trip**, and the fixes are all about deleting round trips or
shortening them. If a page gets slow again, count the round trips first.

- **The functions must live in the same region as the database.** Supabase is in
  `ap-northeast-1` (Tokyo); `vercel.json` pins the functions to `hnd1`. Vercel
  defaults to `iad1` (Washington), and with that default every server→DB call
  crossed the Pacific at ~180ms. A page render makes several of those in
  sequence, which is how `/write` came to take three seconds. `vercel.json` is
  strict JSON and cannot hold a comment saying so, hence this paragraph.
- **`getClaims()`, never `getUser()`, and still never `getSession()`.**
  `getSession()` trusts the cookie as-is and is unsafe. `getUser()` is safe but
  is an HTTP call to the auth server every time. `getClaims()` is both: it calls
  `getSession()` first, so the session still refreshes and the cookie still
  rotates, then verifies the JWT signature locally against the cached JWKS. This
  project signs **ES256**, so that verification is genuinely local and costs no
  network at all. On a project still using the legacy shared HS256 secret it
  falls back to `getUser()` by itself, so the swap can never be worse.
- **Middleware is the one thing the region pin cannot help.** It runs at the
  edge PoP nearest the operator, not in `hnd1`. That is why it verifies locally
  rather than calling the auth server.
- **`createServerSupabase`, `getAuthUser` and `getOrgContext` are all
  `cache()`d, and that is load-bearing.** One render of `/leads?lead=<id>`
  reaches auth from the layout, the page and the drawer. Uncached that was six
  authentications and three `org_members` reads for one request. Anything new
  that needs the current user must go through `getOrgContext()` rather than
  reaching for `supabase.auth` itself, or it silently adds a round trip back.
- **Every page in `(app)` is `force-dynamic`, so `app/(app)/loading.tsx` is not
  decoration.** Without it Next has nothing to show while the server works and
  the browser sits on the *previous* page, which reads as a dead click. Perceived
  speed was a bigger share of "this app is slow" than any single query.
- **Do not select a column the screen does not render.** `loadWriteContext()`
  used to pull `composed_body` for every live send including every `sent` one,
  which is every email ever written, growing forever, on a screen that only ever
  displays the body of a `planned` or `blocked` row. Bodies are now a second,
  narrower query merged in by id.
- **RLS predicates wrap their helpers in a scalar subquery** —
  `org_id = (select app.current_org_id())`, not `org_id = app.current_org_id()`.
  Those helpers are `security definer`, and Postgres never inlines a security
  definer function, so unwrapped it is called once per row: 5000 times on the
  leads grid. The subquery makes it an InitPlan evaluated once. `0030` converted
  all 41 policies; write new ones the same way.

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

## Whose mailbox (`0032`)

For a long time, nothing in the send path had an opinion about this.
`pickMailbox()` was handed every sendable mailbox in the org and returned the
one with the most room, so an email Ojas hand-wrote, to a lead Ojas owned, went
out from `madhav@` whenever that account was emptier. The reply then landed in
Madhav's inbox, and the starter templates on Ojas's screen rendered
`{{sender_name}}` as "Madhav", because that too resolved to *the first mailbox
with a display name*.

None of that was an RLS failure — org scoping held the whole time.
`mailboxes.user_id` had existed since `0013` and the send path never read it.

`lib/scheduler/routing.ts` is the missing half, in priority order:

1. **Pinned** — a lead with any `sent` touch is committed to the mailbox that
   sent it, whoever owns the lead now. `dispatch-sends` looks the prior
   `provider_thread_id` up **per lead** and hands it to whichever mailbox the
   next send names, and a Gmail threadId only exists inside the account that
   issued it. This is a hard requirement, not a courtesy to the prospect.
2. **Owner** — otherwise the mailboxes belonging to `leads.claimed_by`. Several
   is fine; `pickMailbox` still spreads across them by capacity.
3. **Refused** — never somebody else's address.

- **`book.ts` did not change, and that is the point.** `buildCapacity` indexes
  every mailbox in the org while `pickMailbox` only iterates the array it is
  handed, so filtering at the call site is sufficient and the cap arithmetic
  stays in one place. A pinned mailbox with no room today is not a refusal —
  `bookSlot` walks to tomorrow, which is right for a follow-up.
- **Ownership is not `user_id = auth.uid()`.** madhav holds two accounts here:
  `madhav@autoreceptionist.io` connected the mailbox, and
  `madhav@tryautoreceptionist.com` claimed the leads. A strict comparison
  refuses all 30 of them while working perfectly for Ojas, which is a worse bug
  than the one being fixed. `app.same_operator()` resolves it through
  `app.operator_aliases` — exact id first, group as the fallback, the same order
  `0026` established. `public.mailbox_senders()` serves the same answer to
  TypeScript so alias resolution is never reimplemented there.
- **`queue_composed_send()` is the gate, not the composer.** The RPC is
  reachable by any member of the org, so filtering the UI's candidate list makes
  the right thing easy and the wrong thing still possible. The check is on the
  caller, plus the pinned-mailbox exception.
- **`public.reroute_planned_sends_to_owner()` repairs what is already queued**,
  admin only, dry run by default, button on `/import`. It skips pinned leads for
  the reason above, and never touches `claimed`, `sending` or `sent`. It does not
  re-time: the slot an operator was shown is the slot they were promised, and
  `claim_due_sends()` re-checks caps at dispatch anyway.
- **The composer names the sending address before you press Ctrl+Enter.**
  `mailboxEmail` was computed and passed to `WriteClient` for months and never
  rendered, so the first anyone learned of it was the confirmation line
  afterwards. That is how three emails went out of the wrong account unnoticed.

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

## Mapping a CSV nobody has seen before (`0033`)

Header casing and punctuation are already a non-issue: `normalizeHeader()`
lowercases and strips everything non-alphanumeric, so `placeId`, `postalCode`,
`totalScore` and `Work Email` all hit the same synonyms as their snake_case
spellings. What bites is a header that matches the *wrong* field convincingly.

- **`url` is a weak synonym, on `website` and on `gmaps_url` both.** It meant
  the company site in one Clay export and the Google Maps link in the next.
  Strong synonyms are matched for every field first; only then does a leftover
  header fall to a weak one, and `FIELD_SPECS` order breaks the tie — so a file
  with a real `website` column gives `url` to `gmaps_url`, and a bare CSV with
  nothing else gives it to `website`. Getting this backwards is expensive rather
  than untidy: `website_domain` is generated from `website`, a maps link
  normalizes to `google.com`, and that domain is what `/api/v1/demos/pending`
  hands the demo builder, what `POST /api/v1/demos` joins on, and the second key
  `partitionRows()` checks — so an entire second batch collides on one value and
  lands in `/review`.
- **`exact: true` turns the containment pass off for one spec.** Containment
  requires a synonym of 5+ characters inside the header, which is usually what
  you want and is why `title` finds `Use AI Person Title`. But `confidence` sits
  inside `Use AI Confidence Reason`, which is a prose paragraph about who the
  decision maker is, and `email_confidence` is a three-value enum. The real
  `confidence` column still maps, because exact matching is untouched.
- **`person_name` is a synonym of `full_name` and `name` cannot be.** `name` is
  4 characters, under the containment floor, deliberately — the floor is what
  stops `full_name` eating `firstname`. `person_name` clears it and catches
  `Use AI Person Name`. `splitFullName()` then does the rest, correctly, for
  suffixes, middle initials, particles and one-word names alike.
- **`{{first_name}}` still is not in any template.** Capturing the name and
  spending it are separate decisions. A null variable makes `renderTemplate()`
  leave the braces in and the dispatcher skip the send, so a template that
  depends on it converts a thin import into silent skips.

**The mapping screen reports what a mapping would do, not what it is called.**
Per field: how many rows the column filled, and the first cleaned values, as
they would be stored. Plus the headers nothing claims, so a dropped column is
visible. This is the general form of the fix — `website <- url` and
`website <- website` look identical as names and completely different as values,
and so will the next one.

- **Only `work_email` and `company_name` block a commit; the readiness warnings
  never do.** A lead with no resolvable timezone imports clean, qualifies, and
  can never be scheduled — refused by the planner, by `/write`, and by a trigger
  that binds the service role. Nothing used to say so until `/queue`, later. It
  is a warning rather than a block because a list with no coordinates is a real
  thing an operator may knowingly import.
- **An empty column only warns when emptiness changes what the app can do**
  (`CONSEQUENTIAL` in `lib/csv/inspect.ts`). A file with no Twitter handles is
  not a problem, and a warning nobody can act on teaches people to stop reading
  the warnings.
- **Repeated header names are suffixed rather than collapsed.** `parseCsv` keys
  rows by header, so two columns called `email` used to become one and the first
  one's values simply vanished.
- **`public.repair_lead_websites()` fixes leads already imported with a maps
  link**, admin only, dry run by default, button on `/import`. It recovers the
  real site from `leads.raw` via `app.website_from_raw()`, which matches header
  names the same way `normalizeHeader()` does and strips Clay's `✅`. A lead with
  a demo already built reports `repaired, but a demo already exists`, because the
  slug was derived from the wrong domain and no column update fixes that.

## Ownership comes across from the sheet

The sheet names an operator per row in `lead_owner`, and a lead somebody has
already worked has to arrive still belonging to them. It cannot ride along in
the insert — `claimed_by` is guarded and status is derived — so `0025` adds the
bulk sibling of `claim_lead()`: it moves the same three columns under the same
bypass and writes a `claimed` event **whose actor is the named operator, not
whoever ran the import**. A timeline crediting the migration runner would be a
lie about who worked the lead.

- **`backfill_lead_owners()` is how already-imported leads are repaired.** A
  re-upload cannot do it: every row is a duplicate by `work_email` by then, and
  a skipped row has no new lead to claim. `commitImport` stores the original CSV
  row as `leads.raw`, so the owner is already in the database — the backfill
  reads it back out. It defaults to a dry run, and the button is on `/import`.
- **It only ever touches unclaimed leads.** The sheet is a snapshot of what was
  true at export; the database is what is true now. A migration that silently
  overrode live ownership would be the worst of both.
- **An address resolves to an account, or to nothing.** `unknown_owner` leaves
  the lead in the pool and never costs us the lead itself. Since an auth user
  only exists once that person has signed in at least once, an operator who has
  never logged in cannot be assigned to — their rows wait for their first login
  and a second run of the backfill.
- **Exact address beats the alias group** (`0026`). `app.operator_aliases` says
  which addresses are the same human, which is 0009's mess made into data. But
  both of madhav's addresses are real accounts in the org, so group-only
  resolution was ambiguous for every one of his rows. An account at exactly the
  address the sheet names is the strongest evidence there is; the group is the
  fallback for when that address has no account. Two candidates in the fallback
  still raises rather than guessing.
- **Handing a lead to somebody else needs admin**, matching `reassign_lead()`.
  Claiming for yourself does not, so a member can still import their own sheet.

## What the sheet already sent (`0027`)

333 leads came out of `outreach_management` with their touch history stranded in
`leads.raw`. `public.backfill_sheet_touch_history()` moves it across. Admin only,
**dry run by default**, and re-runnable.

- **It writes a `sent` scheduled_send AND a backdated `sent` event per touch,
  and never one without the other.** The event is what makes
  `app.lead_status_from_events` derive `sent`; but neither the planner nor
  `/write` asks the event log which touch is next. Both count from
  `scheduled_sends` rows whose status is `sent`. Events alone would produce
  status `sent` (which opens the planner's gate) over a step count of zero
  (which restarts at T1) - strictly worse than doing nothing. Each lead is
  therefore processed in its own subtransaction.
- **A lead with no timezone gets neither.** `scheduled_sends` refuses it by a
  trigger that binds the service role, so the sends cannot exist, so the events
  must not either. `resolve-timezones` runs hourly and the pass is re-runnable.
- **The step comes from the timestamps, never from the sheet's `status`
  column.** They disagree on 26 rows: 21 say `first_touch` while carrying three
  timestamps, three say `second_touch` while carrying three. Trusting `status`
  would send those 24 businesses a second T2 and a second T3.
- **`p_zone` defaults to `Asia/Kolkata` and is the one inferred number here.**
  The timestamps carry no offset. All 262 cluster at 18:00-23:00 and 01:00-04:00
  with nothing between 05:00 and 12:00, which is US business hours read as IST
  and an implausible sending pattern read as anything else.
- **Day-first, and proved rather than assumed**: 121 values have a first
  component above 12 and none has a second above 12. Six distinct string shapes
  exist, three of them dirty (`31/ 07/26 13:47`, `11/08/26/ 21:40`, stray
  seconds). A parser that only handled the common one would drop a touch and
  restart that lead a step early.
- **`removed` becomes `do_not_contact` plus a suppression on the work email.**
  Both, because the terminal outcome settles this lead while the suppression
  survives a re-import as a new one, and the dispatcher re-checks suppressions
  at send time. Email rather than domain by default: `removed` may have meant
  "wrong contact" as easily as "this company said no". `p_suppress_domain`
  opts in.
- **0027 widens `scheduled_sends_require_content`** so a row arriving already
  `sent`, with a `sent_at`, may carry neither a template nor a body. The sheet
  recorded that an email went out and never what it said, and a fabricated
  `composed_body` would be dispatched verbatim. Anything still dispatchable is
  bound exactly as before; `claim_due_sends()` only ever takes `planned`.

**Recording history is not only bookkeeping.** `sent` outranks `queued`, so a
backfilled lead becomes plannable without anyone pressing "send without an
audit", and its cadence is counted from a `sent_at` months old, so the next
touch is due immediately. That is the point - T4 is overdue - but read the
`next_step` column on a dry run before turning it off. One thing still stands in
the way regardless: `org_settings.dry_run` gates `claim_due_sends()`. The sheet
leads used to be blocked by `is_qualified = false` as well — the sheet carries
no rating column — which is a large part of why `0031` removed the rating floor.

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
- **A skewed machine clock fails the claiming tests and nothing else.**
  `makeDueSend()` seeds `scheduled_at` from the *local* clock at `now() - 1
  minute`, and `claim_due_sends()` requires `scheduled_at <= now()` measured by
  the *database*. More than a minute of skew puts every seeded send in the
  database's future, so the claim matches nothing and three tests in
  `scheduled-sends.test.ts` fail with an empty result rather than an error.
  Check with `select now()` against the machine clock before believing them.

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
