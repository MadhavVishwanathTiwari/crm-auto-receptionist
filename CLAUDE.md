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
8. **Every new table and function grants its API roles in its own migration.**
   Since `0045` no default privilege hands anything to `anon`, `authenticated`
   or `service_role`, on the hosted project or a fresh stack. Before it, the
   hosted project's old defaults granted every new object to all three roles
   *directly*, which is why `0021`'s `revoke ... from public` on `record_demo()`
   never took effect and anon could call it for months: a revoke from `public`
   does not undo a direct grant. A security definer RPC revokes from
   `public, anon, authenticated` and grants exactly who may call it.

## Things that will bite you

- **A PostgREST UPDATE denied by RLS returns 204 with zero rows, not an error.**
  Negative write tests must re-read as a privileged client and assert the value
  is unchanged. Asserting `error !== null` passes vacuously against a completely
  broken policy. Client code must `.select()` after every write and treat `[]`
  as a denial.
- **PostgREST returns at most 1000 rows per response, whatever `.limit()`
  says.** `max_rows` is 1000 on the hosted project and in `config.toml`, and a
  bigger limit is clamped without an error. The leads grid, the planner's
  candidate list and every live send read `.limit(2000)` or `.limit(5000)`
  and would have got 1000. Past that the planner cancels bookings for leads it
  cannot see and the poller cannot match their replies. Anything that needs a
  complete answer reads through `selectAll()` in `lib/supabase/paginate.ts`,
  and on the send path a failed read stops the run instead of acting on half a
  picture; a screen showing the newest N uses `selectUpTo()`. Neither may be
  replaced by a bigger `.limit()`.
- **A guard that trusts `current_user = 'service_role'` does not trust
  `SECURITY DEFINER` functions.** Inside one, `current_user` is the function's
  owner (`postgres`), not whoever called it. `mark_send_sent()` stamped
  `mailboxes.last_send_at`, the `0013` guard refused it, and the rollback took
  the `sent` row and event with it, after Gmail had already accepted the email.
  For three weeks every send was reaped as stalled and booked again: 247
  emails, six businesses getting the same first touch ~40 times (`0040`).
  Every definer function that writes a guarded column sets that guard's bypass
  flag, and every RPC error on the send path is read, never discarded.
- **`app.current_org_id()` must be `SECURITY DEFINER`.** As `SECURITY INVOKER`
  the RLS policy on `org_members` re-enters itself while being evaluated →
  infinite recursion. This is the classic Supabase multi-tenant lockup.
- **A Realtime join made before the session is read goes out as `anon`.**
  `subscribe()` sends the token the socket holds at that instant, which on a
  fresh page is none, and anon can select nothing since `0045`, so every
  change is dropped by RLS without an error. Every live screen was like this
  until `subscribeAsUser()` in `lib/supabase/client.ts`; subscribe through it.
  `select claims_role from realtime.subscription` shows who each join is.
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

## The interface

Dark, dense, desktop-only, and still all of those — but it is a product now
rather than a prototype. The rules:

- **`components/ui/` is the design system, and it is real components.** It
  replaced `app/(app)/ui.ts`, which was six exported class-name *strings* and
  described itself as "not a component library". Variants were string
  concatenation — `BUTTON + " text-danger"` was the destructive button — and a
  caller could not override one utility without a specificity coin flip,
  because Tailwind utilities for the same property have equal specificity and
  the winner is decided by stylesheet order. `cn()` in `lib/cn.ts` (clsx +
  tailwind-merge) settles that by dropping the loser. `ui.ts` survives as a
  shim whose constants are the new components' class strings; nothing new may
  import it, and it goes when the last screen stops.
- **Write `text-ink-3`, never `text-[var(--color-ink-3)]`.** Tailwind v4 has
  been generating the short form from the `@theme` block all along — it
  compiles to the identical `color: var(--color-ink-3)` — and the codebase
  simply never used it, 642 times. Both forms still work; only one is readable.
- **Never name a colour token after a scale step.** `@theme { --color-base }`
  makes `.text-base` a *colour* rather than a font size, app-wide and silently,
  because the colour lookup wins. `base`, `xs`, `sm`, `md`, `lg`, `xl`, `none`,
  `auto`, `current` and the position and border-style keywords are all
  poisoned. Every existing token name is clear of them.
- **`--color-accent` is the one colour that does not mean a status.** It marks
  intent: the primary action, the row you are on, the thing focus is sitting
  on. Everything chromatic other than accent still encodes a fact about a row,
  which is why the grid uses `Badge variant="dot"` rather than fifteen filled
  pills — a coloured cell there has to be worth looking at.
- **The type scale is compressed, and its names track role rather than size.**
  `--text-base` is 13px because the grid is 13px; `text-lg` is 14px and is the
  "comfortable" step that forms, drawers, the dashboard and the composer opt
  into via `PageBody density="comfortable"`.

### Traps

- **Escape is consumed, and listeners check before acting.** The lead drawer,
  the contact card and the board's pending close each listen on `window` and
  navigate away on Escape — correctly, since none of them is modal and the
  platform will not close them. But with a dialog, a menu or the command
  palette open on one of those screens, one Escape would dismiss the overlay
  *and* take the drawer with it. Every overlay in `components/ui` calls
  `stopPropagation` and `preventDefault`; every window listener goes through
  `useEscape` in `lib/ui/useEscape.ts`, which skips a `defaultPrevented` event.
  Add an overlay without doing both and you ship that bug.
- **`min-w-0` on the content wrapper in `app/(app)/layout.tsx` is
  load-bearing.** The leads grid is `w-max min-w-full` and a flex child's
  min-width defaults to `auto`, so without it a wide grid pushes the sidebar off
  the left edge — and there are no responsive breakpoints here to catch it.
- **The Toaster mounts in the ROOT layout, above `ViewerZone`.** ViewerZone
  keys its children by zone and remounts them the first time a browser reports
  a zone the cookie disagrees with, which is the first-visit path. A provider
  inside that takes an in-flight toast with it. `lib/ui/toast.ts` is a
  module-level store rather than a context for the same reason.
- **`ROW_HEIGHT = 30` is mirrored in three places** — `--row-height` in
  `globals.css`, and a JS const in `LeadsGrid.tsx` and `ContactDirectory.tsx`,
  both of which write it inline as `style={{ height: ROW_HEIGHT }}` and feed it
  to `estimateSize`. Changing the CSS variable alone changes only the skeleton.
  Any padding or border added to a grid ROW rather than to its CELLS desyncs
  the virtualizer and the scrollbar drifts over five thousand rows.
- **A cookie read by the server and written by the client needs its name in an
  import-free module.** `lib/ui/prefs.ts` is `server-only`; the sidebar is a
  client component; `SIDEBAR_COOKIE` therefore lives in `lib/ui/cookies.ts`.
  Same shape as `SUPPRESSION_REASONS` and as `ZONE_COOKIE`.
- **`npm run verify` now runs `next build`.** It had to: vitest here is
  node-only with no jsdom and no `.tsx` tests, so nothing in the suite can
  catch a Tailwind error or a client/server boundary violation, and `main`
  auto-deploys. A manual pass of the fifteen routes is still part of done.
- **`nav.ts` annotates `{ href: Route }[]` and must not use `as const`** — with
  typed routes, a bare union of a dozen literal hrefs makes `Link` infer its
  generic from the wrong member and reject every other one.
- **`app/no-access/page.tsx` imports `SignOutButton` from `(app)`.** It is
  unreachable in normal operation, so if that export goes away nobody notices
  for months.

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
  **Until `0040` that was only half true:** the reaper never retried, but the
  planner saw no sent touch and booked the step again, which is a retry by
  another name. A `failed`/`stalled` row now holds its lead everywhere: a
  trigger refuses new bookings (service role included), `claim_due_sends()`
  skips anything already booked, and the planner and `/write` say why. Only a
  person settles it — `resolve_stalled_send()` from the lead drawer, or
  `repair_stalled_sends()` on `/import` for a backlog.
- **A `claimed` row is released, never reaped (`0046`).** Between
  `claim_due_sends()` and `mark_send_sending()` nothing has touched Gmail, so a
  claim older than `stall_minutes` goes back to `planned` through
  `release_expired_claims()`, which the dispatcher calls before it claims.
  Until `0046` nothing moved a row out of `claimed` at all: a dispatcher killed
  in that window, or refused by `mark_send_sending()` with an error nobody
  read, froze its lead for good while `/write` called it "on its way".
  Releasing clears the claim token, so a dispatcher still holding it is
  refused at the point of no return and cannot send it.
- **Only a 4xx from Gmail is a failure.** A timeout, a dropped connection, a
  5xx or a 200 without an id may each be an email that went out, so the row is
  left in `sending` for the reaper to park as `stalled` and an alert says to
  check the Sent folder. Recording those as `failed` let `/write` offer the step
  again. Before `mark_send_sending()`, anything that may pass (a paused mailbox,
  a token that would not refresh, a suppression list or any other read that
  errored) leaves the row `claimed` for `release_expired_claims()` rather than
  spending somebody's written email. A suppression read that errors is never
  "not suppressed". A real failure raises an alert, because otherwise the lead
  just shows the same step again and its author never learns why.
- **Every RPC error on the send path is read.** `mark_send_sent()` failing
  after Gmail accepted the message is not a failed send: the dispatcher parks
  the row as `stalled` via `mark_send_unrecorded()`, keeping Gmail's ids so the
  follow-up can still thread, and raises an alert.
- **One send per mailbox at a time, 5 to 15 minutes apart (`0041`).** Before
  it, hashed minutes could coincide and the five-minute dispatcher sent
  everything due in one burst, so two emails left one account seconds apart.
  The gap is enforced in `claim_due_sends()`, the only place that knows when a
  mailbox last sent: one claim per mailbox per run, then
  `mailboxes.next_send_not_before` closes for a random
  `send_gap_min..max_minutes`. It is set at CLAIM, under the advisory lock, not
  when Gmail answers, because the next run can start before this one reaches
  Gmail. `bookSlot()` keeps bookings on one mailbox the MAX gap apart, so a
  booked send is never held past a tick: the time `/write` promises stays true
  and nothing drifts into `slot_grace_minutes`. The dispatcher runs every
  minute; at five, "random" would round to 5, 10 or 15.
- **Never two emails to one lead inside 20 hours (`0042`).** `claim_due_sends()`
  skips a send while any other row for that lead reached Gmail in the last 20
  hours: `sending_at` for the dispatcher's own, `sent_at` for history recorded
  from a Sent folder, whatever the row's status. The shortest real gap between
  touches is two business days, so nothing legitimate ever waits on it. It is a
  ceiling on the next repeat bug, whatever causes it; `0040` fixed the one we
  know about.
- **A body is plain text plus one piece of markup, `[words](https://…)`.**
  `lib/gmail/body.ts` sends it as multipart/alternative: the text, with each
  link written as `words (address)`, and bare HTML where the words are the
  link. The HTML part has no styling, images, tracking pixel or redirects. An
  address that is not whole `http(s)` is never linked, and `/write` refuses
  one rather than letting the brackets go out. The stored body stays the source.
- **A follow-up's subject is its thread's, `Re:` and all.** Gmail ignores
  `threadId` when the subject differs and starts a new conversation. The T2–T4
  templates carried their own `Re:` subject, which matched only a templated T1,
  so all 14 app-sent follow-ups to hand-written T1s landed as new threads
  (Sep 2026). The dispatcher now overrides the subject from the thread's first
  `rendered_subject` via `replySubject()`, and `/write` shows that subject
  locked.
- **Gmail replaces the Message-ID of everything it sends.** The header
  `buildMimeMessage()` writes never reaches the prospect; theirs says
  `…@mail.gmail.com`. Until Sep 2026 the dispatcher recorded its own anyway,
  so every follow-up's In-Reply-To named a message nobody had: Gmail threads
  past that on `threadId`, Outlook and Apple Mail do not. `sendMessage()` now
  reads the real one back (null if it cannot, never ours), and a follow-up's
  In-Reply-To/References are read from Gmail by `provider_message_id` at
  dispatch, so the wrong ids still stored on older rows never reach a header.
- **Every email carries `List-Unsubscribe`, pointing at the sending mailbox.**
  `<mailto:that mailbox?subject=unsubscribe>`, so Gmail shows "Unsubscribe"
  beside the sender and the request lands in the inbox `poll-replies` already
  reads; `classifyInbound()` files it as an unsubscribe like any other. A spam
  report costs the domain's reputation for every later prospect, an unsubscribe
  costs one lead. No `List-Unsubscribe-Post`: one-click needs an https endpoint
  that acts with no human, and there is none. **It also forced
  `classifyInbound()` to read only what the person wrote** (`newText()`, above
  the quoted original): a reply quoting our headers back contains the word
  "unsubscribe", and suppressing on that would drop a prospect who just said
  yes. The bounce path still reads the whole report, because a DSN's status
  code is inside the quote.
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
- **A date from before the sheet existed is a typo, not a touch (`0043`).**
  Nuvo HVAC's `06/08/25 22:41` meant 2026. Read literally it became a phantom
  T1 a year before the real email, too far away for `0042`'s 36-hour match, so
  `/write` ran a step ahead of the prospect. `parse_sheet_timestamp()` now
  returns NULL before June 2026 or more than a day in the future, which both
  passes already report as an unreadable cell.
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

## What the mailboxes already sent (`0042`)

Past the sheet there was a second gap: the Sent folders themselves. On 12 Sep
`/write` offered 141 of Ojas's leads as T1; 122 had already had a first touch by
hand from Gmail and 43 had had three. `0027` never recorded them, and even run,
the sheet is a second-hand account with no thread id to follow up on.

`scripts/reconcile-mailbox-history.mjs` reads every connected mailbox's Sent
folder (`gmail.readonly`, no new scope) and hands each lead's touches to
`public.record_mailbox_touches()`. **Dry run unless `--apply`**, and the dry
run calls the same functions with `p_dry_run`, so its report is what applying
would do rather than an estimate of it.

- **Gmail is the authority; the sheet fills gaps.** A message whose id matches a
  row's `provider_message_id` is that row. One within 36 hours of a row with no
  message id (`0027`'s sheet rows, `0040`'s after-the-fact records) lends it its
  ids. A sheet cell no message accounts for is recorded as `0027` would have,
  token and all.
- **One touch per prospect-local day, the latest.** On Sep 10 the loop sent some
  leads three different first touches in one afternoon under three subjects, so
  a subject is no key. No real sequence has ever put two touches on one day, and
  the latest is the attempt `0040`'s repair recorded.
- **A Gmail id's embedded time is when the message was created, not when it
  left.** The top bits of a hex message id are a millisecond timestamp, and for
  a Gmail scheduled send that is the moment it was scheduled. About twenty
  follow-ups were scheduled at once on 6 Aug 20:30 UTC and went out between 7
  and 13 Aug. TI Mechanical's T3 has an id reading 7 Aug (IST); its
  `internalDate`, its Date header and the sheet cell all say 13 Aug 21:49 IST,
  which is what the app records. `touchFrom()` takes `internalDate`; never read
  a date off an id.
- **Recorded rows carry the mailbox and the thread**, which is what pins the
  follow-up to the account holding the conversation and lets `dispatch-sends`
  thread it. `template_id` and `composed_body` stay null: nothing says which
  copy it was.
- **Steps are renumbered by date.** An earlier email turning up moves the app's
  own row up a step, highest-first so two live rows never share one. More than
  four distinct touches is refused (`too_many_touches`), not squeezed in:
  `step_number` is 1 to 4.
- **Recorded history means hand-written follow-ups.** `hasRecordedHistory()` in
  `plan-sends`: a `sent` row with neither a template nor a body is an email a
  person sent from their own mailbox, so the planner cancels any template
  booked for that lead and leaves the next touch to `/write`. It still re-times
  a written send whose slot passed.
- **`public.close_leads_dnc()`** closes with a `closed` event and a `manual_dnc`
  suppression, keyed by token. The script uses it for the sheet's `removed` rows
  (`sheet:removed`, `0027`'s own token) and for every lead the loop sent one
  email five or more times.
- **Inbound history too.** Replies, bounces and unsubscribes that arrived before
  `poll-replies` ran are classified by the app's own `classifyInbound()` and
  recorded with the poller's event shape and dedupe token, so the poller can
  never add a second.
- **It keeps itself caught up (`0044`).** `reconcile-mailboxes` runs nightly
  at 23:30 UTC and does the same thing for the last three days of every
  connected Sent folder, so an email either operator sends straight from Gmail
  is recorded by morning. It skips replied and closed leads (an operator's
  email after a reply is a conversation, not a touch), skips the sheet, and
  raises one `pre_send_review` alert per lead for anything a person must settle:
  a lead written to from both mailboxes, more than four touches, no timezone,
  or nobody owning it. An unclaimed lead with recorded history is on nobody's
  `/write` and the planner leaves hand-written sequences alone, so without that
  alert its next touch is offered to no one.
  The one-off script is still the tool for anything older than `?days=14`.
- The script imports `lib/gmail/classify.ts`, `lib/gmail/touches.ts` and
  `lib/normalize/email.ts` directly; Node 24 strips the types. Keep all three
  free of imports and of non-erasable syntax (enums, parameter properties), or
  the script stops loading. `touches.ts` takes the normalizer as an argument
  for exactly that reason.

## The pipeline, which is a second dimension (`0035`/`0036`)

Everything up to `replied` was built. Past it there was nothing: no way to
record that a call is booked, no note, no follow-up date, no screen showing
which conversations are open. `close_lead()` was the only remaining move.

`leads.stage` is that missing half, and it is **not** more `lead_status` values.

|  | `leads.status` | `leads.stage` |
|---|---|---|
| means | what the machine did | where the human thinks the deal is |
| derived from | `lead_events`, **rank-ordered** | `lead_events`, **last write wins** |
| direction | forward only | any |
| written by | the send path | `set_lead_stage()` |

`app.lead_status_from_events` takes the maximum rank so a late `delivered`
webhook cannot walk a replied lead backwards. A sales stage is the opposite: a
no-show sends `meeting` back to `engaged`. Ranking stages would break that
guarantee for everything or lock every deal forward. Both columns stay derived
and both stay guarded, so "status is derived, never typed" is unchanged.

- **`app.lead_stage_from_events` falls back to `engaged` on any `replied`
  event**, which is what makes the board populate itself. The fallback is
  checked *after* any explicit move, so a lead parked in `nurture` is not
  yanked back by the next reply — the reply raises an alert and the human
  decides.
- **Won / lost / DNC are `terminal_outcome`, not stages.** `columnFor()` in
  `lib/pipeline/stages.ts` prefers the outcome, so a closed lead keeps the stage
  it died at and still files under its outcome. One answer to "did we win".
- **`set_lead_stage()` checks ownership with `app.same_operator`**, not
  `claimed_by = auth.uid()`. That is the `0032` lesson: a strict comparison
  refuses all of madhav's leads while working for Ojas. The drawer's stage
  control is therefore *not* gated on the UI's strict `editable` flag — the RPC
  arbitrates. `next_action` and `deal_value` still are, because those are plain
  UPDATEs and `leads_update` itself compares strictly.
- **`prospect` is excluded from every money figure**, and the board shows it as
  a count rather than cards. Thousands of unworked leads times the default value
  is a headline number nobody believes, and a total nobody believes is worth
  less than no total.
- **`deal_value` is null on almost every lead and null means
  `org_settings.default_deal_value`.** A per-lead amount everybody has to
  maintain is a column that goes stale, and a stale number on a board shown to a
  client is worse than no number.
- **`note` finally gets written.** It has been in the enum since `0001` and
  permitted to authenticated users since `0005`, and nothing ever wrote one. It
  ranks 0, so commentary cannot move status.

### The `queued` event never reached the database (`0036`)

`0022` designed "send without an audit" around a `queued` event and said the
leads screen "now writes" one. It did — through the RLS client, against a
`lead_events_insert` policy that permits only `('audited', 'note',
'manual_override')`. The button never worked for anybody.

Worth being exact, because the action was written for the wrong failure: **a
`with check` violation on INSERT raises 42501 outright.** The silent
204-with-zero-rows case is UPDATE and DELETE, where a `using` clause filters the
row out before there is anything left to violate. That is why `setLeadTimezone`
genuinely needs its zero-row check and this never did.

Fixed with `public.queue_lead_without_audit()` rather than by widening the
policy, which checks `org_id` and nothing else and would have let either
operator queue the other's leads.

## Demo leads (`0037`)

22 fabricated businesses, seeded through the real machinery — leads, then
`lead_events` and `sent` `scheduled_sends`, with the triggers deriving status,
stage and `halted_at`. A fixture that wrote those columns directly would prove
nothing; this way a broken derivation is visibly broken.

They are **meant to stay**. Three properties keep them safe in a live sender:

1. Every address is on `example.com`, which RFC 2606 reserves so it can never be
   a real mailbox. This is the one that matters.
2. `source = 'demo'` on every row — free text, no schema change, one `where`
   clause from being found or removed.
3. Every one carries a `replied` event, so all 22 are halted and out of the
   planner's reach. **There are deliberately no demo leads in `prospect`:** a
   sendable fake lead would pollute `/queue` and `/settings`, and the Prospect
   column shows a count anyway, so the demo gained nothing from them.

`public.remove_demo_leads()` is the undo — admin only, dry run by default. It
has no button on purpose; a "delete the demo data" control next to a live demo
is a bad thing to be one click away from.

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

The cron routes take `POST` with `Authorization: Bearer $CRON_SECRET`, and
each accepts an optional `?org=<uuid>` to scope a run to one org. Cadence, as
scheduled by `0020`: `resolve-timezones` hourly, `plan-sends` every 15 minutes,
`dispatch-sends` every minute since `0041` (at most one send per mailbox per
run, so `?limit=` now only caps how many mailboxes one run serves),
`poll-replies` every 5 since `0054` (it was 10, and the AI replier's
five-minute promise cannot be kept behind a ten-minute poll), `ai-replies`
every 2 since `0054`, and `reconcile-mailboxes` once a night at 23:30 UTC
since `0044` (`?days=` widens its three-day lookback, up to 14).

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
`AR_INGEST_SECRET`. They are the Auto-Receptionist repo's whole work queue and
write-back target; its nightly `build-from-crm.mjs` reads the first and posts
to the second. The `outreach_management` sheet is no longer read by anything.

- **`/pending` returns qualified leads with a website and no demo yet**, and
  drops suppressed domains. It does NOT require the first touch to have gone
  out: demos are built at qualification so T1's copy is true and T2 is not
  racing a build.
- **Priority, then oldest first:** leads whose T1 is out (`sent/delivered/
  opened`, T2 is waiting on this demo), then owned ones (`claimed/audited/
  queued`), then untouched ones. It reads every candidate through `selectAll()`
  and slices after sorting, so `limit` never cuts before the priority does.
- **`verification = 'invalid'` is excluded; `unknown` is not.** Most Clay
  imports are `unknown` and are emailed like anything else, so they need a demo
  for T2 like anything else.
- **It hands over the Maps facts**: `phone`, `city`, `state`, `company_name`,
  and `timezone` with its `timezone_source`. The builder uses our zone instead
  of its own state-and-city table, which refused every Texas town it did not
  list, and may fill the four essentials from the listing when the site does
  not state them, labelled as ours in its provenance report. Handing a zone out
  is safe whatever its source, because nothing here ever stores a guessed one.
- **A refused build is a `demo_failed` event (`0051`).** The builder posts its
  refusals as `failures: [{ lead_id, reason, stage }]` in the same POST, one
  per lead per UTC day (`dedupe_token = demo_failed:<date>`). It is rank 0, so
  it moves no status. `/pending` skips a lead with one in the last 7 days, which
  is what stops the same unbuildable sites taking every night's budget; the
  lead drawer and `/write` show the reason, because "no demo" and "the builder
  gave up on this site" used to look identical.
- **`POST ?dry_run=1` matches and writes nothing**: no `record_demo()`, no
  event, no orphan alert. Results come back `would_record` / `would_orphan`
  with the lead's status. The AR repo's `backfill-crm-demos.mjs` reads it
  before recording demos built before this contract existed.
- **`POST` joins on normalized domain**, `place_id` first when present and
  `lead_id` first when the caller echoes one back. A payload matching no lead
  raises an `orphan_demo` alert rather than being dropped, because somebody paid
  a model to build it.
- **The `timezone` that repo reports back is accepted and never applied.** It
  is kept in the `demo_ready` event payload for comparison only.
- **`record_demo()` is the only writer of the demo columns.** The guard in
  `0004` binds the service role too, so the route cannot UPDATE the row itself.
- **The builder posts a demo only after its Vercel deployment succeeds.**
  `demo_ready_at` unblocks the planner within 15 minutes, and
  `autoreceptionist.io/sandbox/<anything>` answers 200 whether the slug exists
  or not, so a finished deployment is the only proof the link works.

## Reply alerts

`poll-replies` writes `alerts` rows; `/alerts` reads them live over Realtime
(`0018` publishes the table, with `replica identity full` for the reason `0012`
records). Set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_IDS`, or `NTFY_TOPIC`, and
each newly inserted alert also goes to a phone. Unconfigured is a no-op, and a
push failure never fails the poll: only a genuinely new row notifies, which is
what stops an overlapping history page buzzing twice for one reply.

**The cursor only moves past what is settled.** From 17 Aug `madhav@`'s poll
threw on every run and answered a row of zeros under a 200, so pg_cron said
"succeeded" and nothing said the mailbox was not being read. Now:

- a message deleted before it is read is skipped, not thrown on, so it cannot
  wedge the cursor behind it;
- a reply whose event fails to record stops the run *without* moving past it,
  because the event is what halts the sequence;
- a run out of time (40s budget) or pages stores the last record it finished,
  not nothing (the same backlog forever) and not Gmail's current history id
  (skipping every unread page);
- the error is in the response body, which `net._http_response` keeps for a
  few hours, and `last_polled_at` only moves on a run with no error;
- a mailbox with no complete poll for an hour raises one `mailbox_auth` alert
  a day, pushed to a phone.

A cursor Gmail has aged out still rebaselines to "now", and now says which
window was never read: `scripts/reconcile-mailbox-history.mjs` recovers
replies, bounces and unsubscribes from it.

## The assistant that answers replies (`0052`/`0053`/`0054`)

A prospect replies, the sequence halts, an alert fires, a phone buzzes, and then
nothing happens until a human opens Gmail. Between two operators in IST and
prospects in US business hours that gap is routinely hours. `ai-replies` closes
it: five minutes after a reply arrives, if nobody has answered, it reads the
thread and decides whether there is anything worth saying.

- **It cannot answer a stranger, structurally.** Its candidates are `replied`
  `lead_events`, and `poll-replies` only writes one for mail `matchLead()`
  resolved to a lead in this org; everything else is `unmatched` and dropped
  before it could become an event. The route then narrows again, because
  `matchLead()` will attribute a thread by its References chain to a message
  sent from *any* address: the sender has to be the lead's own `work_email_norm`
  or a colleague on its `website_domain`, or it is skipped with an alert.
- **Off, draft, send** — `org_settings.ai_reply_mode`, default `off`, the same
  shape as `dry_run`. With it off the route returns before its first Gmail call
  and its first model call. `draft` writes the exact email it would have sent
  and sends nothing; `/knowledge` is where you read them.
- **Five minutes is measured from Gmail's `internalDate`**, not from
  `lead_events.occurred_at`, which is when the poller got round to writing the
  row. Those are the same on a quiet afternoon and hours apart after a backlog,
  and gating on the wrong one makes a whole day's replies eligible in one tick.
  `poll-replies` now stores it as `payload.internal_date`; an event from before
  `0053` falls back to `occurred_at`, which is late rather than wrong.
- **`claim_ai_reply()` writes the row BEFORE Gmail is called**, under a
  per-mailbox `pg_advisory_xact_lock`, and `unique (org_id, inbound_message_id)`
  arbitrates between two overlapping ticks. Same rule as the dispatcher marking
  `sending` before the Gmail call, for the same reason. pg_cron does not
  serialize invocations, and a two-minute tick with a model call in it will
  overlap.
- **An AI reply is not a `scheduled_sends` row**, because `step_number` is 1..4
  and a reply is not a step, `claim_due_sends()` refuses anything for a lead that
  reached Gmail in the last 20 hours (`0042`) and a reply is usually hours after
  the touch it answers, and the `replied` event has already halted that lead.
- **It is still a real email out of a real Gmail account, and that part is not
  exempt.** `ai_replies` carries `cap_date` exactly as `scheduled_sends` does,
  `claim_ai_reply()` honours `mailboxes.next_send_not_before` and closes it
  behind itself, and `claim_due_sends()` was restated in `0053` to count both
  tables. Without that the claimer believes in headroom that does not exist —
  the cap is a reputation limit on the *account*, not an outreach budget — and
  two emails could leave one mailbox in the same second, which is the bug `0041`
  exists to prevent. A paused mailbox does not auto-reply, matching
  `dispatch-sends`; that candidate is deferred rather than consumed.
- **Every outcome writes a row**, including every refusal, so the next tick two
  minutes later skips the event rather than paying to re-decide it. The skips
  are the majority and they carry the reason, which is the only way to answer
  "why did it not reply to this one". Transient failures — a paused mailbox, a
  token that would not refresh, a Gmail read that errored, a suppression list
  that could not be read — write nothing and retry.
- **Only a 4xx from Gmail is a failure.** A timeout, a 5xx or a 200 with no id
  parks the row as `stalled` with an alert saying to check the Sent folder,
  never retried, exactly as the dispatcher does. A wrong guess is a second email.
- **The guard is what actually binds, not the prompt.** `lib/ai/reply/guard.ts`
  refuses a leftover `{{variable}}`, a body over 1500 characters, any email
  address that is not the sending mailbox, and any URL that is not the booking
  link or this lead's demo. It reads links through `linkedUrls()` in
  `lib/gmail/body.ts`, which returns **both** the `[words](url)` form and a bare
  URL in the prose, because `toHtml()` anchors both — a guard that only knew the
  bracket form would pass `just go to https://wherever` and then send it live.
- **No `List-Unsubscribe` on a 1:1 reply, and `Auto-Submitted: auto-replied` on
  it instead.** The unsubscribe header is right on outbound a prospect did not
  ask for and absurd on an answer to "yes, send me a time". RFC 3834 is what
  lets everybody else's autoresponder loop prevention see what this is — our own
  `classifyInbound()` reads that header for exactly that purpose.
- **Once per thread, then it hands off.** `claim_ai_reply()` refuses a lead that
  already has a `sending`/`sent`/`stalled` row. A prospect who writes twice is a
  conversation, and the route also stands down if a newer inbound or any `SENT`
  message appeared in the thread while it was deciding.
- **The nightly reconciler never sees these sends**, and that property is
  load-bearing: `reconcile-mailboxes` filters `.is("halted_at", null)`, and the
  `replied` event that triggered the assistant is what sets `halted_at`. Delete
  that filter and the assistant becomes a sequence-corrupter, so
  `tests/integration/ai-replies.test.ts` asserts it rather than assuming it.
- **A sent reply writes an `ai_replied` event**, not a `note`. It ranks 0 so it
  moves no status, but it is its own type because a cron-written `note` has
  `actor_id` null and would be indistinguishable in the drawer timeline from one
  an operator typed.
- **`/knowledge` is the whole surface**: the business context, the answers it may
  give, and the last 50 things it did with them. Writing there is admin-only,
  same authority as `org_settings`, because it is what an autonomous sender says
  in somebody's name. `ai_replies` has no insert or update policy for
  `authenticated` at all — there is no approve-and-send button, and a row an
  operator could edit stops being a record of what happened.
- **`ANTHROPIC_API_KEY`** is server-only, not `required` (the app and every other
  job run without it), and is in `FORBIDDEN_NAMES` in the bundle check. The one
  model call is `lib/ai/reply/decide.ts` — `claude-opus-5`, adaptive thinking,
  structured output through `zodOutputFormat`. **No `fallbacks` parameter, on
  purpose:** on a refusal the right move for an email going out in somebody's
  name is to stop and tell a person, not to re-run it on another model and send
  whatever comes back. A refusal, a truncation, or an answer that will not parse
  all resolve to a row and an alert.

## Where the tests run

`tests/setup/target.ts` runs the suites against the **local** stack, and fails
if it is not running. **Cloud only with `TEST_TARGET=cloud`**, and it warns when
it does. It used to fall back to cloud on its own, which was defensible while
the project was empty and stopped being so when real leads and a live sender
arrived.

A fresh local stack only works because of `0045`. Current Supabase stacks give
the API roles nothing on objects `postgres` creates, and no migration before
`0045` granted anything, so every suite failed in setup with `permission
denied for table orgs`.

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
  normalized domain. Its nightly `Daily demos from the CRM` workflow reads
  `GET /api/v1/demos/pending` and posts built demos and refusals back to
  `POST /api/v1/demos`; see "The demo contract".
