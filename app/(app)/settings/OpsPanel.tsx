"use client";

import { useState, useTransition } from "react";

import { describeRun } from "@/lib/ops/describeRun";
import { formatYours } from "@/lib/time/format";

import { BUTTON, PANEL } from "../ui";
import { useViewerZone } from "../ViewerZone";
import { type JobRunResult, runJobNow } from "./actions";

/** One row of public.background_jobs_status(), or null when unscheduled. */
export interface ScheduledJob {
  job: string;
  schedule: string;
  active: boolean;
  last_run_at: string | null;
  last_status: string | null;
}

export interface JobDescriptor {
  name: string;
  label: string;
  blurb: string;
  cadence: string;
  scheduled: ScheduledJob | null;
}

/**
 * Runs a job on demand.
 *
 * Until a scheduler is calling these on an interval, this panel IS the
 * scheduler, and it stays useful afterwards: "plan it now" is what you press
 * after auditing a lead rather than waiting fifteen minutes to see it booked.
 */
export function OpsPanel({ jobs }: { jobs: JobDescriptor[] }) {
  const { zone } = useViewerZone();
  const [result, setResult] = useState<JobRunResult | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(name: string) {
    setResult(null);
    setRunning(name);
    startTransition(async () => {
      const outcome = await runJobNow(name);
      setResult(outcome);
      setRunning(null);
    });
  }

  const unscheduled = jobs.filter((job) => !job.scheduled?.active).length;

  return (
    <div className={PANEL}>
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-ink">Jobs</h2>
        <span
          className={
            unscheduled === 0
              ? "text-ok"
              : "text-warn"
          }
        >
          {unscheduled === 0
            ? "running on a schedule"
            : unscheduled === jobs.length
              ? "nothing runs by itself yet"
              : `${unscheduled} not scheduled`}
        </span>
      </div>
      <p className="mt-1 mb-3 text-ink-2">
        The same routes pg_cron calls, with the same secret check. Each is safe
        to run twice: the planner is idempotent on (lead, step) and the
        dispatcher claims a row before it touches Gmail.
      </p>

      <div className="space-y-2">
        {jobs.map((job) => (
          <div key={job.name} className="flex flex-wrap items-baseline gap-3">
            <button
              type="button"
              onClick={() => run(job.name)}
              disabled={pending}
              className={BUTTON + " w-44 text-left"}
            >
              {running === job.name ? "running..." : job.label}
            </button>
            <span className="min-w-0 flex-1 text-ink-2">
              {job.blurb}
            </span>
            <span className="tabular w-32 shrink-0 text-right text-ink-3">
              {job.scheduled?.schedule ?? job.cadence}
            </span>
            <span className="w-44 shrink-0 text-right">
              {job.scheduled ? (
                <span
                  className={
                    job.scheduled.last_status === "failed"
                      ? "text-danger"
                      : "text-ink-3"
                  }
                >
                  {job.scheduled.last_run_at
                    ? `${job.scheduled.last_status ?? "ran"} ${formatYours(
                        job.scheduled.last_run_at,
                        zone,
                      )}`
                    : "scheduled, never run"}
                </span>
              ) : (
                <span className="text-warn">manual only</span>
              )}
            </span>

            {/* Under the button that was pressed, not at the foot of the
                panel: a result five rows below the click, as a JSON dump,
                read as no result at all. */}
            {running === job.name && (
              <p className="basis-full pl-[11.75rem] text-ink-3">
                Running. This can take up to a minute.
              </p>
            )}
            {result?.job === job.name && running !== job.name && (
              <JobResult result={result} />
            )}
          </div>
        ))}
      </div>

      {unscheduled > 0 && (
        <p className="mt-3 text-ink-3">
          Scheduling turns on once this deployment has a public URL: put it and
          CRON_SECRET in Vault, then run{" "}
          <code>select app.enable_background_jobs();</code>. Until then these
          buttons are the scheduler, and the app works entirely from them.
        </p>
      )}

    </div>
  );
}

/** What a run did, as a sentence, with the route's own JSON a click away. */
function JobResult({ result }: { result: JobRunResult }) {
  const { text, problem } = describeRun(result);
  return (
    <div className="basis-full pl-[11.75rem]">
      <p className={problem ? "text-danger" : "text-ok"}>
        {text}
      </p>
      {result.body != null && (
        <details className="mt-1">
          <summary className="cursor-pointer text-ink-3">
            what the job returned
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto text-ink-2">
            {typeof result.body === "string"
              ? result.body
              : JSON.stringify(result.body, null, 1)}
          </pre>
        </details>
      )}
    </div>
  );
}

