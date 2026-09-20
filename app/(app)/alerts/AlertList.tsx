"use client";

import { BellOff, Check, CheckCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";

import { createBrowserSupabase, subscribeAsUser } from "@/lib/supabase/client";
import { formatYours } from "@/lib/time/format";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/cn";
import type { Tone } from "@/lib/ui/tones";

import { useViewerZone } from "../ViewerZone";
import { acknowledgeAlert, acknowledgeAllAlerts } from "./actions";

import { toast } from "@/lib/ui/toast";

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
const KIND_COPY: Record<string, { label: string; tone: Tone }> = {
  reply: { label: "reply", tone: "ok" },
  bounce: { label: "bounce", tone: "danger" },
  unsubscribe: { label: "unsubscribe", tone: "danger" },
  mailbox_auth: { label: "mailbox auth", tone: "danger" },
  cap_exhausted: { label: "cap exhausted", tone: "warn" },
  import_failed: { label: "import failed", tone: "danger" },
  orphan_demo: { label: "orphan demo", tone: "warn" },
  timezone_unresolved: {
    label: "no timezone",
    tone: "warn",
  },
  dedupe_review: { label: "dedupe review", tone: "info" },
  demo_missing: { label: "demo missing", tone: "warn" },
  pre_send_review: { label: "pre-send review", tone: "info" },
  ai_reply: { label: "assistant", tone: "info" },
  new_pool_leads: { label: "new pool leads", tone: "info" },
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
    tone: "neutral",
  };
  const seen = alert.acknowledged_at !== null;
  const { zone } = useViewerZone();

  return (
    <li
      className={cn(
        "flex items-center gap-3 border-t border-line py-1.5 first:border-t-0",
        seen && "opacity-50",
      )}
    >
      <span className="w-32 shrink-0">
        <Badge tone={copy.tone}>{copy.label}</Badge>
      </span>
      <span className="tabular w-36 shrink-0 text-ink-3">
        {formatYours(alert.created_at, zone)}
      </span>
      <span className="w-52 shrink-0 truncate font-medium text-ink">
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
      <span className="min-w-0 flex-1 truncate text-ink-2">
        {alert.message}
      </span>
      {!seen && (
        <Button
          size="sm"
          icon={<Check size={13} />}
          onClick={() => onAcknowledge(alert.id)}
          disabled={pending}
          className="shrink-0"
        >
          Done
        </Button>
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
      );

    return subscribeAsUser(supabase, channel);
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
      // The result used to be discarded, so an acknowledge that RLS refused
      // looked exactly like one that worked -- the row greyed out optimistically
      // and came back on the next reload.
      const result = await acknowledgeAlert(id);
      if (!result.ok) toast.error("Could not mark that done", result.error);
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
      const result = await acknowledgeAllAlerts();
      if (!result.ok) toast.error("Could not mark them done", result.error);
    });
  }

  const open = alerts.filter((alert) => !alert.acknowledged_at);
  const seen = alerts.filter((alert) => alert.acknowledged_at);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-baseline gap-3">
          <h2 className="text-xl font-semibold text-ink">Open</h2>
          <span className="tabular text-ink-2">{open.length}</span>
          {open.length > 0 && (
            <Button
              size="sm"
              icon={<CheckCheck size={13} />}
              onClick={acknowledgeAll}
              disabled={pending}
              className="ml-auto"
            >
              Mark all done
            </Button>
          )}
        </div>

        {open.length === 0 ? (
          <EmptyState
            compact
            icon={<BellOff size={16} />}
            title="Nothing waiting"
            body="Replies, bounces and unsubscribes land here as the poller finds them, and each one has already halted its sequence through the event log."
          />
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
      </Card>

      {seen.length > 0 && (
        <Card className="p-4">
          <div className="flex items-baseline gap-3">
            <h2 className="text-xl font-semibold text-ink-2">Done</h2>
            <span className="tabular text-ink-3">
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
        </Card>
      )}
    </div>
  );
}
