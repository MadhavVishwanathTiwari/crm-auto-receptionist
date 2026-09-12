// Reconciles what the app has recorded as sent with what the mailboxes sent.
//
// Each connected mailbox's Sent folder is the only complete record. The sheet
// era (July and August) was sent by hand out of Gmail and never reached
// scheduled_sends, so /write offered leads a first touch they had already had,
// some of them three times over. This reads every connected mailbox, read-only
// (gmail.readonly, the scope the app already holds), and hands each lead's real
// history to public.record_mailbox_touches() (0042), which matches what the app
// already has, renumbers around it, and records the rest.
//
// Passes, in the order they apply:
//
//   closures  the sheet's `removed` rows, and every lead 0040's loop sent one
//             email REPEAT_CLOSE_MIN_COPIES times or more, become
//             do_not_contact with a suppression
//   touches   Sent-folder history per lead, merged in SQL with the sheet cells
//   inbound   replies, bounces and unsubscribes that arrived before the poller
//             was running, recorded the way poll-replies records them
//   report    one row per lead: the step /write shows now, and the step it is
//             actually on
//
// DRY RUN unless --apply. The dry run calls the same database functions with
// p_dry_run, so what it reports is what applying would do rather than an
// estimate of it.
//
// Usage:
//   node scripts/reconcile-mailbox-history.mjs [--apply] [--org <uuid>]
//        [--out report.csv] [--skip-closures] [--skip-inbound]
//
// normalizeEmail and classifyInbound are imported from lib/ as TypeScript
// (Node 24 strips the types), so an address is matched and a reply classified
// exactly as the app does it, not by a copy of the rules that drifts.

import { writeFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

import { classifyInbound, eventTypeFor } from "../lib/gmail/classify.ts";
import { normalizeEmail } from "../lib/normalize/email.ts";

config({ path: ".env", quiet: true });

const argv = process.argv.slice(2);
const dryRun = !argv.includes("--apply");
const option = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? (argv[at + 1] ?? null) : null;
};
const onlyOrg = option("--org");
const outPath = option("--out");
const skipClosures = argv.includes("--skip-closures");
const skipInbound = argv.includes("--skip-inbound");

/** The sheet's timestamps carry no offset. 0027 proved they are IST. */
const SHEET_ZONE = "Asia/Kolkata";

/**
 * Copies of one email that put a business beyond an apology. The loop sent
 * seven of them the same first touch 5 to 41 times. Three more got a second or
 * third copy, which is a mistake, not a reason never to write again.
 */
const REPEAT_CLOSE_MIN_COPIES = 5;

const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

if (!apiUrl || !serviceKey || !clientId || !clientSecret) {
  console.error(
    "Needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and the Google OAuth client in .env.",
  );
  process.exit(1);
}

const db = createClient(apiUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// Plumbing

async function selectAll(build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Mirrors getMailboxAccessToken(): the cached token if it has life left. */
async function accessTokenFor(mailbox) {
  const { data: secret, error } = await db
    .from("mailbox_secrets")
    .select("refresh_token, access_token, access_token_expires_at")
    .eq("mailbox_id", mailbox.id)
    .maybeSingle();
  if (error || !secret) throw new Error(`${mailbox.email}: no stored grant`);

  const expires = secret.access_token_expires_at
    ? Date.parse(secret.access_token_expires_at)
    : 0;
  // Five minutes, not zero: a full Sent-folder read takes a while.
  if (secret.access_token && expires > Date.now() + 5 * 60_000) {
    return secret.access_token;
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: secret.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.access_token) {
    throw new Error(`${mailbox.email}: token refresh failed (${response.status})`);
  }

  // Cached where the dispatcher looks, with the same minute of headroom, so
  // this run does not make it mint another.
  await db
    .from("mailbox_secrets")
    .update({
      access_token: payload.access_token,
      access_token_expires_at: new Date(
        Date.now() + ((payload.expires_in ?? 3600) - 60) * 1000,
      ).toISOString(),
      ...(payload.refresh_token ? { refresh_token: payload.refresh_token } : {}),
    })
    .eq("mailbox_id", mailbox.id);

  return payload.access_token;
}

async function gmail(token, path) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${GMAIL}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.ok) return response.json();
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    const detail = await response.text().catch(() => "");
    throw new Error(
      `gmail ${path.split("?")[0]} failed (${response.status}): ${detail.slice(0, 200)}`,
    );
  }
}

async function listIds(token, params) {
  const ids = [];
  let pageToken = null;
  do {
    const query = new URLSearchParams({ maxResults: "500", ...params });
    if (pageToken) query.set("pageToken", pageToken);
    const page = await gmail(token, `/messages?${query}`);
    ids.push(...(page.messages ?? []).map((message) => message.id));
    pageToken = page.nextPageToken ?? null;
  } while (pageToken);
  return [...new Set(ids)];
}

function headerMap(payload) {
  const headers = {};
  for (const header of payload?.headers ?? []) {
    const name = header.name?.toLowerCase();
    if (name && headers[name] === undefined) headers[name] = header.value ?? "";
  }
  return headers;
}

/** The same parts lib/gmail/messages.ts collects, DSN reports included. */
function collectText(part, out) {
  if (!part) return;
  const mime = part.mimeType ?? "";
  const isText =
    mime.startsWith("text/plain") ||
    mime.startsWith("message/") ||
    mime.startsWith("text/rfc822-headers");
  if (isText && part.body?.data) {
    out.push(Buffer.from(part.body.data, "base64url").toString("utf8"));
  }
  for (const child of part.parts ?? []) collectText(child, out);
}

const ADDRESS = /[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g;

function normalizedAddresses(...values) {
  const found = values.flatMap((value) => (value ?? "").match(ADDRESS) ?? []);
  return [...new Set(found.map((address) => normalizeEmail(address)).filter(Boolean))];
}

function localDate(iso, zone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** What /write would offer right now. Mirrors nextStepFor(). */
function writeStep(lead, sends) {
  if (lead.terminal_outcome) return "closed";
  if (lead.halted_at) return "halted";
  if (sends.some((s) => s.status === "claimed" || s.status === "sending")) {
    return "in flight";
  }
  if (sends.some((s) => s.status === "failed" && s.error_code === "stalled")) {
    return "held";
  }
  const live = sends.find((s) => s.status === "planned" || s.status === "blocked");
  const sent = sends.filter((s) => s.status === "sent").map((s) => s.step_number);
  const step = live ? live.step_number : Math.max(0, ...sent) + 1;
  return step > 4 ? "finished" : `T${step}`;
}

// ---------------------------------------------------------------------------

const reportRows = [];

async function reconcileOrg(orgId, mailboxes) {
  console.log(`\norg ${orgId}: ${mailboxes.map((m) => m.email).join(", ")}`);

  const leads = await selectAll(() =>
    db
      .from("leads")
      .select(
        "id, company_name, work_email, work_email_norm, timezone, claimed_by, status, terminal_outcome, halted_at, sheet_status:raw->>status, sheet_first_touch:raw->>first_touch",
      )
      .eq("org_id", orgId)
      .is("archived_at", null)
      .order("id"),
  );
  const sends = await selectAll(() =>
    db
      .from("scheduled_sends")
      .select("id, lead_id, step_number, status, error_code")
      .eq("org_id", orgId)
      .order("id"),
  );
  const { data: userList } = await db.auth.admin.listUsers({ perPage: 200 });
  const emailOf = new Map((userList?.users ?? []).map((u) => [u.id, u.email]));

  const leadByEmail = new Map();
  for (const lead of leads) {
    if (lead.work_email_norm && !leadByEmail.has(lead.work_email_norm)) {
      leadByEmail.set(lead.work_email_norm, lead);
    }
  }

  const sendsByLead = new Map();
  for (const send of sends) {
    const list = sendsByLead.get(send.lead_id) ?? [];
    list.push(send);
    sendsByLead.set(send.lead_id, list);
  }

  const rows = new Map();
  const rowFor = (lead) => {
    let row = rows.get(lead.id);
    if (!row) {
      const now = writeStep(lead, sendsByLead.get(lead.id) ?? []);
      row = {
        org_id: orgId,
        lead_id: lead.id,
        company: lead.company_name ?? "",
        email: lead.work_email ?? "",
        owner: emailOf.get(lead.claimed_by) ?? "",
        write_step_now: now,
        write_step_after: now,
        gmail_touches: 0,
        collapsed_repeats: 0,
        outcome: "",
        touches: "",
        next_step: "",
        inserted: "",
        enriched: "",
        renumbered: "",
        cancelled: "",
        closure: "",
        inbound: "",
        detail: "",
      };
      rows.set(lead.id, row);
    }
    return row;
  };

  // --- closures -------------------------------------------------------------
  const closing = new Set();

  async function close(targets, token, note) {
    for (let i = 0; i < targets.length; i += 100) {
      const chunk = targets.slice(i, i + 100);
      const { data, error } = await db.rpc("close_leads_dnc", {
        p_lead_ids: chunk.map((lead) => lead.id),
        p_token: token,
        p_note: note,
        p_dry_run: dryRun,
      });
      if (error) throw new Error(`close_leads_dnc: ${error.message}`);
      for (const result of data ?? []) {
        const lead = chunk.find((l) => l.id === result.lead_id);
        const row = rowFor(lead);
        row.closure = `${result.outcome} (${token})`;
        if (result.outcome === "closed") {
          closing.add(lead.id);
          row.write_step_after = "closed";
        }
      }
    }
  }

  if (!skipClosures) {
    const repeats = new Map();
    for (const send of sends) {
      if (send.status === "failed" && send.error_code === "sent_unrecorded_repeat") {
        repeats.set(send.lead_id, (repeats.get(send.lead_id) ?? 0) + 1);
      }
    }
    // A repeat row is one extra copy of the recorded send beside it.
    const overSent = leads.filter(
      (lead) =>
        !lead.terminal_outcome &&
        (repeats.get(lead.id) ?? 0) + 1 >= REPEAT_CLOSE_MIN_COPIES,
    );
    const removed = leads.filter(
      (lead) => !lead.terminal_outcome && (lead.sheet_status ?? "").trim() === "removed",
    );

    await close(
      overSent,
      "repeat-send",
      "sent the same email repeatedly by the 0040 recording bug; never contact again",
    );
    await close(removed, "sheet:removed", "sheet status was removed");
    console.log(
      `  closures: ${overSent.length} sent repeatedly, ${removed.length} removed in the sheet`,
    );
  }

  // --- touches --------------------------------------------------------------
  const touchesByLead = new Map();
  const mailboxesByLead = new Map();

  for (const mailbox of mailboxes) {
    mailbox.token = await accessTokenFor(mailbox);
    const ids = await listIds(mailbox.token, { labelIds: "SENT" });
    const messages = await pool(ids, 8, (id) =>
      gmail(
        mailbox.token,
        `/messages/${id}?format=metadata&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc&metadataHeaders=Subject&metadataHeaders=Message-ID`,
      ),
    );
    console.log(`  ${mailbox.email}: ${ids.length} sent messages read`);

    for (const message of messages) {
      const headers = headerMap(message.payload);
      for (const address of normalizedAddresses(headers.to, headers.cc, headers.bcc)) {
        const lead = leadByEmail.get(address);
        if (!lead) continue; // warmup, or ordinary mail

        const list = touchesByLead.get(lead.id) ?? [];
        list.push({
          message_id: message.id,
          thread_id: message.threadId ?? null,
          rfc822_id: headers["message-id"] ?? null,
          subject: headers.subject ?? null,
          mailbox_id: mailbox.id,
          sent_at: new Date(Number(message.internalDate)).toISOString(),
        });
        touchesByLead.set(lead.id, list);

        const boxes = mailboxesByLead.get(lead.id) ?? new Set();
        boxes.add(mailbox.email);
        mailboxesByLead.set(lead.id, boxes);
      }
    }
  }

  const candidates = leads.filter(
    (lead) =>
      !closing.has(lead.id) &&
      !lead.terminal_outcome &&
      (touchesByLead.has(lead.id) || (lead.sheet_first_touch ?? "").trim() !== ""),
  );

  await pool(candidates, 4, async (lead) => {
    const row = rowFor(lead);
    const raw = (touchesByLead.get(lead.id) ?? []).sort((a, b) =>
      a.sent_at.localeCompare(b.sent_at),
    );

    // One touch per prospect-local day, the LATEST of that day. On Sep 10 the
    // loop sent some leads three different first touches inside three hours
    // under three different subjects, so a subject is no key, and no real
    // sequence ever put two touches on one day. The latest is also the attempt
    // 0040's repair recorded, so it matches that row instead of lending it
    // another email's thread.
    const byDay = new Map();
    for (const touch of raw) byDay.set(localDate(touch.sent_at, lead.timezone), touch);
    const touches = [...byDay.values()];
    row.gmail_touches = touches.length;
    row.collapsed_repeats = raw.length - touches.length;

    // A thread lives in one account. Two accounts writing to one lead is a
    // question about which one owns the conversation, and a pin guessed wrong
    // puts the follow-up in the wrong inbox.
    if ((mailboxesByLead.get(lead.id)?.size ?? 0) > 1) {
      row.outcome = "conflict";
      row.detail = `touches from ${[...mailboxesByLead.get(lead.id)].join(" and ")}`;
      return;
    }

    const { data, error } = await db.rpc("record_mailbox_touches", {
      p_lead_id: lead.id,
      p_touches: touches,
      p_sheet_zone: SHEET_ZONE,
      p_dry_run: dryRun,
    });

    if (error) {
      row.outcome = "error";
      row.detail = error.message;
      return;
    }

    const result = data?.[0] ?? {};
    Object.assign(row, {
      outcome: result.outcome ?? "",
      detail: result.detail ?? "",
      touches: result.touches ?? "",
      next_step: result.next_step ?? "",
      inserted: result.inserted ?? "",
      enriched: result.enriched ?? "",
      renumbered: result.renumbered ?? "",
      cancelled: result.cancelled ?? "",
    });

    if (["recorded", "would_record", "already_present"].includes(result.outcome)) {
      if (!lead.halted_at) {
        row.write_step_after = result.next_step ? `T${result.next_step}` : "finished";
      }
    }
  });

  // --- inbound --------------------------------------------------------------
  if (!skipInbound) {
    const existing = await selectAll(() =>
      db
        .from("lead_events")
        .select("lead_id, type, dedupe_token")
        .eq("org_id", orgId)
        .in("type", ["replied", "bounced", "unsubscribed"])
        .order("id"),
    );
    const recorded = new Set(existing.map((e) => `${e.lead_id}|${e.type}|${e.dedupe_token}`));
    const leadById = new Map(leads.map((lead) => [lead.id, lead]));

    for (const mailbox of mailboxes) {
      const emailedLeads = [...touchesByLead.entries()]
        .filter(([, touches]) => touches.some((t) => t.mailbox_id === mailbox.id))
        .map(([leadId]) => leadById.get(leadId))
        .filter((lead) => lead?.work_email);
      const emailedNorms = new Set(emailedLeads.map((lead) => lead.work_email_norm));

      const ids = [];
      for (let i = 0; i < emailedLeads.length; i += 25) {
        const chunk = emailedLeads.slice(i, i + 25).map((lead) => lead.work_email);
        ids.push(
          ...(await listIds(mailbox.token, {
            q: `from:(${chunk.join(" OR ")})`,
            includeSpamTrash: "true",
          })),
        );
      }
      ids.push(
        ...(await listIds(mailbox.token, {
          q: "from:(mailer-daemon OR postmaster)",
          includeSpamTrash: "true",
        })),
      );

      const messages = await pool([...new Set(ids)], 6, (id) =>
        gmail(mailbox.token, `/messages/${id}?format=full`),
      );

      let found = 0;
      for (const message of messages) {
        const headers = headerMap(message.payload);
        const parts = [];
        collectText(message.payload, parts);
        const text = parts.join("\n");
        const labelIds = message.labelIds ?? [];

        const classification = classifyInbound({
          labelIds,
          headers,
          text,
          snippet: message.snippet ?? "",
        });
        if (classification.kind === "ignore") continue;

        // A bounce names the address that failed rather than being from it.
        let lead = null;
        if (classification.kind === "bounce") {
          const named = normalizedAddresses(headers["x-failed-recipients"], text);
          const hit = named.find((address) => emailedNorms.has(address));
          lead = hit ? leadByEmail.get(hit) : null;
        } else {
          const [sender] = normalizedAddresses(headers.from);
          lead = sender ? (leadByEmail.get(sender) ?? null) : null;
        }
        if (!lead) continue;

        const type = eventTypeFor(classification.kind);
        const key = `${lead.id}|${type}|${message.id}`;
        if (!type || recorded.has(key)) continue;
        recorded.add(key);
        found += 1;

        const at = new Date(Number(message.internalDate)).toISOString();
        const row = rowFor(lead);
        row.inbound = [row.inbound, `${type} ${at.slice(0, 10)}`].filter(Boolean).join("; ");
        if (row.write_step_after.startsWith("T") || row.write_step_after === "finished") {
          row.write_step_after = type === "replied" ? "halted (replied)" : `halted (${type})`;
        }

        if (dryRun) continue;

        // The shape poll-replies writes, dated when it arrived. The Gmail id
        // is the dedupe token there too, so the poller can never add a second.
        const { error: eventError } = await db.from("lead_events").upsert(
          {
            org_id: orgId,
            lead_id: lead.id,
            type,
            actor_id: null,
            occurred_at: at,
            payload: {
              mailbox_id: mailbox.id,
              gmail_message_id: message.id,
              gmail_thread_id: message.threadId,
              from: headers.from ?? null,
              subject: headers.subject ?? null,
              snippet: (message.snippet ?? "").slice(0, 500),
              classification: classification.reason,
              hard: classification.hard,
              source: "mailbox_history",
            },
            dedupe_token: message.id,
          },
          { onConflict: "lead_id,type,dedupe_token", ignoreDuplicates: true },
        );
        if (eventError) {
          row.detail = [row.detail, `inbound event: ${eventError.message}`].filter(Boolean).join("; ");
          continue;
        }

        if (classification.hard && lead.work_email_norm) {
          const { error: suppressionError } = await db.from("suppressions").insert({
            org_id: orgId,
            email_norm: lead.work_email_norm,
            reason: classification.kind === "unsubscribe" ? "unsubscribed" : "bounced_hard",
            lead_id: lead.id,
            notes: classification.reason,
          });
          if (suppressionError && suppressionError.code !== "23505") {
            row.detail = [row.detail, `suppression: ${suppressionError.message}`]
              .filter(Boolean)
              .join("; ");
          }
        }

        await db.from("alerts").upsert(
          {
            org_id: orgId,
            lead_id: lead.id,
            mailbox_id: mailbox.id,
            kind:
              classification.kind === "reply"
                ? "reply"
                : classification.kind === "bounce"
                  ? "bounce"
                  : "unsubscribe",
            message: `${headers.from ?? "someone"} (${at.slice(0, 10)}): ${(message.snippet ?? "").slice(0, 160)}`,
            dedupe_token: message.id,
          },
          { onConflict: "org_id,kind,dedupe_token", ignoreDuplicates: true },
        );
      }
      console.log(`  ${mailbox.email}: ${found} unrecorded replies/bounces/unsubscribes`);
    }
  }

  // --- summary --------------------------------------------------------------
  const all = [...rows.values()];
  reportRows.push(...all);

  const tally = (key) =>
    Object.entries(
      all.reduce((acc, row) => {
        if (row[key]) acc[row[key]] = (acc[row[key]] ?? 0) + 1;
        return acc;
      }, {}),
    )
      .map(([name, count]) => `${name}: ${count}`)
      .join(", ");

  console.log(`  touches: ${tally("outcome") || "none"}`);
  console.log(`  closures: ${tally("closure") || "none"}`);

  const owners = new Set(all.map((row) => row.owner).filter(Boolean));
  for (const owner of owners) {
    const mine = all.filter((row) => row.owner === owner);
    const before = mine.filter((row) => row.write_step_now === "T1").length;
    const after = mine.filter((row) => row.write_step_after === "T1").length;
    console.log(`  ${owner}: /write shows ${before} leads as T1; ${after} actually are`);
  }
}

// ---------------------------------------------------------------------------

const { data: mailboxRows, error: mailboxError } = await db
  .from("mailboxes")
  .select("id, org_id, email")
  .is("disconnected_at", null)
  .order("email");

if (mailboxError) {
  console.error(mailboxError.message);
  process.exit(1);
}

const orgs = new Map();
for (const mailbox of mailboxRows ?? []) {
  if (onlyOrg && mailbox.org_id !== onlyOrg) continue;
  const list = orgs.get(mailbox.org_id) ?? [];
  list.push(mailbox);
  orgs.set(mailbox.org_id, list);
}

console.log(dryRun ? "DRY RUN: nothing will be written. Pass --apply to write." : "APPLYING.");

for (const [orgId, mailboxes] of orgs) {
  await reconcileOrg(orgId, mailboxes);
}

if (outPath && reportRows.length > 0) {
  const columns = Object.keys(reportRows[0]);
  const escape = (value) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  writeFileSync(
    outPath,
    [columns.join(","), ...reportRows.map((row) => columns.map((c) => escape(row[c])).join(","))].join("\n"),
  );
  console.log(`\nreport: ${outPath} (${reportRows.length} leads)`);
}
