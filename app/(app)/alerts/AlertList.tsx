"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";

import { createBrowserSupabase } from "@/lib/supabase/client";

import { BUTTON_QUIET, PANEL } from "../ui";
import { acknowledgeAlert, acknowledgeAllAlerts } from "./actions";

export interface AlertRow {
  id: string;
  kind: string;
  message: string;
  lead_id: string | null;
  acknowledged_at: string | null;
  created_at: string;
  lead_company: string | null;
}

/**
 * What each kind means, in the words the operator would use.
 *
 * Tone encodes urgency, not category: a reply is the thing you wanted, a bounce
 * costs domain reputation, and the rest are the pipeline telling you it has
 * stopped doing something.
 */
const KIND_COPY: Record<string, { label: string; tone: string }> = {
  reply: { label: "reply", tone: "text-[var(--color-ok)]" },
  bounce: { label: "bounce", tone: "text-[var(--color-danger)]" },
  unsubscribe: { label: "unsubscribe", tone: "text-[var(--color-danger)]" },
  mailbox_auth: { label: "mailbox auth", tone: "text-[var(--color-danger)]" },
  cap_exhausted: { label: "cap exhausted", tone: "text-[var(--color-warn)]" },
  import_failed: { label: "import failed", tone: "text-[var(--color-danger)]" },
  orphan_demo: { label: "orphan demo", tone: "text-[var(--color-warn)]" },
  timezone_unresolved: {
    label: "no timezone",
    tone: "text-[var(--color-warn)]",
  },
  dedupe_review: { label: "dedupe review", tone: "text-[var(--color-info)]" },
  demo_missing: { label: "demo missing", tone: "text-[var(--color-warn)]" },
  pre_send_review: { label: "pre-send review", tone: "text-[var(--color-info)]" },
  new_pool_leads: { label: "new pool leads", tone: "text-[var(--color-info)]" },
};

function AlertLine({
  alert,
  onAcknowledge,
  pending,
}: {
  alert: AlertRow;
  onAcknowledge: (id: string) => void;
  pending: boolean;
}) {
  const copy = KIND_COPY[alert.kind] ?? {
    label: alert.kind.replace(/_/g, " "),
    tone: "text-[var(--color-ink-2)]",
  };
  const seen = alert.acknowledged_at !== null;

  return (
    <li
      className={
        "flex items-baseline gap-3 border-t border-[var(--color-line)] py-1 " +
        (seen ? "opacity-50" : "")
      }
    >
      <span className={"w-32 shrink-0 " + copy.tone}>{copy.label}</span>
      <span className="tabular w-36 shrink-0 text-[var(--color-ink-3)]">
        {new Date(alert.created_at).toLocaleString()}
      </span>
      <span className="w-52 shrink-0 truncate text-[var(--color-ink)]">
        {alert.lead_id ? (
          <Link
            href={`/leads?lead=${alert.lead_id}`}
            className="hover:underline"
          >
            {alert.lead_company ?? "open the lead"}
          </Link>
        ) : (
          "—"
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[var(--color-ink-2)]">
        {alert.message}
      </span>
      {!seen && (
        <button
          type="button"
          onClick={() => onAcknowledge(alert.id)}
          disabled={pending}
          className={BUTTON_QUIET + " shrink-0"}
        >
          done
        </button>
      )}
    </li>
  );
}

export function AlertList({ rows }: { rows: AlertRow[] }) {
  // The server prop is the seed; Realtime patches this copy in place.
  const [alerts, setAlerts] = useState(rows);
  const [prevRows, setPrevRows] = useState(rows);
  const [pending, startTransition] = useTransition();

  // Adjusting state during render rather than in an effect, the same way the
  // grid does: a fresh prop arrives on every revalidation, and reconciling it
  // from an effect renders stale rows for a frame and trips the lint rule
  // against synchronous setState in effects.
  if (prevRows !== rows) {
    setPrevRows(rows);
    setAlerts(rows);
  }

  // Live, for the same reason the grid is: this screen is meant to be left
  // open on a second monitor. Realtime only forwards rows the subscriber's RLS
  // policy accepts, so the org boundary is enforced by the policy rather than
  // by anything filtered here.
  useEffect(() => {
    const supabase = createBrowserSupabase();

    const channel = supabase
      .channel("alerts-feed")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "alerts" },
        (payload) => {
          const row = payload.new as AlertRow | null;
          if (!row?.id) return;

          setAlerts((current) => {
            const index = current.findIndex((alert) => alert.id === row.id);
            // The pushed row has no lead_company: that column comes from an
            // embedded select the WAL knows nothing about. Keep the one already
            // rendered rather than blanking the company on acknowledge.
            if (index === -1) return [{ ...row, lead_company: null }, ...current];
            const next = [...current];
            next[index] = { ...row, lead_company: current[index]!.lead_company };
            return next;
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  function acknowledge(id: string) {
    // Optimistic: the row greys out immediately, and Realtime confirms it.
    setAlerts((current) =>
      current.map((alert) =>
        alert.id === id
          ? { ...alert, acknowledged_at: new Date().toISOString() }
          : alert,
      ),
    );
    startTransition(async () => {
      await acknowledgeAlert(id);
    });
  }

  function acknowledgeAll() {
    const now = new Date().toISOString();
    setAlerts((current) =>
      current.map((alert) =>
        alert.acknowledged_at ? alert : { ...alert, acknowledged_at: now },
      ),
    );
    startTransition(async () => {
      await acknowledgeAllAlerts();
    });
  }

  const open = alerts.filter((alert) => !alert.acknowledged_at);
  const seen = alerts.filter((alert) => alert.acknowledged_at);

  return (
    <div className="space-y-4">
      <div className={PANEL}>
        <div className="flex items-baseline gap-3">
          <h2 className="text-[var(--color-ink)]">Open</h2>
          <span className="tabular text-[var(--color-ink-2)]">{open.length}</span>
          {open.length > 0 && (
            <button
              type="button"
              onClick={acknowledgeAll}
              disabled={pending}
              className={BUTTON_QUIET + " ml-auto"}
            >
              mark all done
            </button>
          )}
        </div>

        {open.length === 0 ? (
          <p className="mt-2 text-[var(--color-ink-3)]">
            Nothing waiting. Replies, bounces and unsubscribes land here as the
            poller finds them, and each one has already halted its sequence
            through the event log.
          </p>
        ) : (
          <ul className="mt-2">
            {open.map((alert) => (
              <AlertLine
                key={alert.id}
                alert={alert}
                onAcknowledge={acknowledge}
                pending={pending}
              />
            ))}
          </ul>
        )}
      </div>

      {seen.length > 0 && (
        <div className={PANEL}>
          <div className="flex items-baseline gap-3">
            <h2 className="text-[var(--color-ink-2)]">Done</h2>
            <span className="tabular text-[var(--color-ink-3)]">
              {seen.length}
            </span>
          </div>
          <ul className="mt-2">
            {seen.map((alert) => (
              <AlertLine
                key={alert.id}
                alert={alert}
                onAcknowledge={acknowledge}
                pending={pending}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
