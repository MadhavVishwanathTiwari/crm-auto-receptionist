import "server-only";

import { headers } from "next/headers";

import { serverEnv } from "@/lib/env";

/**
 * The four background jobs, and the button that runs one now.
 *
 * Nothing about the pipeline is event-driven: a lead becomes sendable when a
 * human audits it, and the planner notices on its next tick. That is fine when
 * a scheduler is calling these on an interval, and it is the whole game when
 * one is not yet, which is where this deployment currently stands. So the
 * operator gets a button.
 *
 * The button calls the route over HTTP with the cron secret rather than
 * importing the job's code, and that indirection is deliberate:
 *
 *   - The service-role key stays behind the /api/cron boundary CLAUDE.md draws.
 *     A server action that imported the job would put an RLS-bypassing client
 *     one function call away from a browser event handler.
 *   - It exercises the exact path pg_cron will take, secret check included. A
 *     "run now" that works while the scheduled call 401s is worse than no
 *     button at all.
 *
 * The cost is one loopback request per click, which at four clicks a day is
 * not a cost.
 */
export const JOBS = [
  {
    name: "resolve-timezones",
    label: "Resolve timezones",
    blurb:
      "Turns coordinates into IANA zones. A lead with no zone is never scheduled.",
    cadence: "hourly",
  },
  {
    name: "plan-sends",
    label: "Plan sends",
    blurb:
      "Books the next touch for every eligible lead, in the prospect's local morning.",
    cadence: "*/15 * * * *",
  },
  {
    name: "dispatch-sends",
    label: "Dispatch sends",
    blurb:
      "Sends what is due, 20 per run. Refuses to do anything while dry run is on.",
    cadence: "*/5 * * * *",
  },
  {
    name: "poll-replies",
    label: "Poll replies",
    blurb:
      "Reads the mailboxes for replies, bounces and unsubscribes, and halts those sequences.",
    cadence: "*/10 * * * *",
  },
] as const;

export type JobName = (typeof JOBS)[number]["name"];

export function isJobName(value: string): value is JobName {
  return JOBS.some((job) => job.name === value);
}

/**
 * The origin this server is reachable at, from the request currently being
 * handled.
 *
 * Same reasoning as lib/requestOrigin.ts, which does this for a Request object:
 * a configured NEXT_PUBLIC_SITE_URL can disagree with the host the operator is
 * actually standing on, and here that would send the loopback call to a
 * different deployment than the one whose button was pressed.
 */
async function selfOrigin(): Promise<string> {
  const header = await headers();
  const host = header.get("x-forwarded-host") ?? header.get("host");
  if (!host) {
    // No request headers means no way to name ourselves. The configured value
    // is the last resort rather than the first.
    const configured = serverEnv().siteUrl;
    if (configured) return configured;
    throw new Error("Could not work out this server's own origin.");
  }

  const proto =
    header.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");

  return `${proto}://${host}`;
}

export interface JobRun {
  ok: boolean;
  status: number;
  /** The route's own JSON summary, rendered back to the operator verbatim. */
  body: unknown;
  error?: string;
}

export async function runJob(name: JobName): Promise<JobRun> {
  const { cronSecret } = serverEnv();
  if (!cronSecret) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: "CRON_SECRET is not set, so the job routes refuse every caller.",
    };
  }

  const url = `${await selfOrigin()}/api/cron/${name}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cronSecret}` },
      cache: "no-store",
    });

    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // A non-JSON body means something upstream answered instead of the
      // route: a proxy, or Vercel's deployment protection. Keep the text.
    }

    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: error instanceof Error ? error.message : "The request failed.",
    };
  }
}
