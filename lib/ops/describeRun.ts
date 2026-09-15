// A job run from /settings, in words.
//
// Each route answers with its own JSON, and the panel used to print "Done."
// above a toggle for anything that was not resolve-timezones. For the poller
// that hid the one answer anyone presses the button for: did it find the reply
// (Sep 2026, E2E lead 2: one unsubscribe, reported as "Done."). It also printed
// a mailbox that failed inside an otherwise 200 response in green.
//
// Plain module with no imports: the settings panel is a client component, and
// lib/ops/jobs.ts, which defines the run's shape, reads server-only env.

/** What runJobNow() hands back. Structurally lib/ops/jobs.ts's JobRun + job. */
export interface RunForDescription {
  job: string;
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
}

export interface RunDescription {
  text: string;
  /** Something needs a look, even if the route itself answered 200. */
  problem: boolean;
}

function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function num(record: Record<string, unknown> | null, key: string): number {
  return Number(record?.[key] ?? 0) || 0;
}

function describeTimezones(body: Record<string, unknown>): RunDescription {
  const fromCoordinates = num(body, "resolved");
  const fromPlace = num(body, "placed");
  const stillMissing = num(body, "unresolved") + num(body, "unplaced");
  const fixed = fromCoordinates + fromPlace;

  const parts = [
    fixed === 0
      ? stillMissing === 0
        ? "Nothing was waiting on a timezone."
        : "No lead could be given a timezone this time."
      : `Gave ${plural(fixed, "lead")} a timezone: ${fromCoordinates} from coordinates, ${fromPlace} from their city.`,
  ];
  if (stillMissing > 0) {
    parts.push(
      `${plural(stillMissing, "lead")} still ${stillMissing === 1 ? "needs" : "need"} one set by hand on the lead, and ${stillMissing === 1 ? "is" : "are"} never scheduled until then.`,
    );
  }
  if (body.more) {
    parts.push(`Ran out of time with ${num(body, "deferred")} untried; run it again.`);
  }
  return { text: parts.join(" "), problem: false };
}

/**
 * What the poller found, led by the thing that changes a lead: replies,
 * bounces and unsubscribes, each of which has now stopped that sequence. A
 * mailbox that could not be read is named, because it means replies there are
 * not being heard.
 */
function describePoll(body: Record<string, unknown>): RunDescription {
  const reports = (Array.isArray(body.reports) ? body.reports : [])
    .map(asRecord)
    .filter((report): report is Record<string, unknown> => report !== null);

  const total = (key: string) => reports.reduce((sum, report) => sum + num(report, key), 0);
  const replies = total("replies");
  const bounces = total("bounces");
  const unsubscribes = total("unsubscribes");
  const examined = total("examined");

  const found = [
    replies > 0 ? plural(replies, "reply", "replies") : null,
    bounces > 0 ? plural(bounces, "bounce") : null,
    unsubscribes > 0 ? plural(unsubscribes, "unsubscribe") : null,
  ].filter((part): part is string => part !== null);

  const parts: string[] = [];
  parts.push(
    found.length > 0
      ? `Found ${found.join(", ")}. ${found.length === 1 && replies + bounces + unsubscribes === 1 ? "That lead's" : "Those leads'"} emails are stopped; see Alerts.`
      : examined > 0
        ? `Read ${plural(examined, "new message")}; none was a reply, bounce or unsubscribe from a lead.`
        : "Nothing new in any mailbox.",
  );

  let problem = false;
  for (const report of reports) {
    const mailbox = String(report.mailbox ?? "a mailbox");
    if (typeof report.error === "string" && report.error) {
      problem = true;
      parts.push(`${mailbox} could not be read: ${report.error}`);
    } else if (report.caught_up === false) {
      problem = true;
      parts.push(
        `${mailbox} stopped before the end${typeof report.stopped === "string" ? ` (${report.stopped})` : ""}; run it again.`,
      );
    }
    if (report.rebaselined === true) {
      parts.push(
        `${mailbox}'s place in its history had expired, so it restarted from now; anything older needs the mailbox reconcile script.`,
      );
    }
  }

  if (reports.length === 0) parts.push("No connected mailbox was polled.");

  return { text: parts.join(" "), problem };
}

export function describeRun(result: RunForDescription): RunDescription {
  const body = asRecord(result.body);

  if (!result.ok) {
    const reason = result.error ?? (typeof body?.error === "string" ? body.error : null);
    return {
      text: `Failed${result.status ? ` (${result.status})` : ""}.${reason ? ` ${reason}` : ""}`,
      problem: true,
    };
  }

  if (result.job === "resolve-timezones" && body) return describeTimezones(body);
  if (result.job === "poll-replies" && body) return describePoll(body);

  return { text: "Done.", problem: false };
}
