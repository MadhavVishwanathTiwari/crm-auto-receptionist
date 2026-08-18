"use client";

import Link from "next/link";
import { DateTime } from "luxon";
import { useEffect, useState, useTransition } from "react";

import {
  BOARD_COLUMNS,
  COLUMN_LABEL,
  columnFor,
  dealValue,
  formatMoney,
  isOverdue,
  PIPELINE_STAGES,
  pipelineValue,
  type BoardColumn,
  type PipelineStage,
  weightedValue,
  wonValue,
} from "@/lib/pipeline/stages";
import { createBrowserSupabase } from "@/lib/supabase/client";

import { STAGE_TONE } from "../ui";
import { setStage } from "./actions";

export interface BoardRow {
  id: string;
  company_name: string | null;
  city: string | null;
  state: string | null;
  claimed_by: string | null;
  status: string;
  status_updated_at: string;
  stage: string;
  stage_changed_at: string | null;
  terminal_outcome: string | null;
  deal_value: number | string | null;
  next_action: string | null;
  next_action_at: string | null;
}

/** A card only exists for a lead somebody is working, or one already closed. */
function qualifies(row: { stage: string; terminal_outcome: string | null }) {
  return row.stage !== "prospect" || row.terminal_outcome !== null;
}

function relative(iso: string | null): string {
  if (!iso) return "";
  return DateTime.fromISO(iso).toRelative() ?? "";
}

export function PipelineBoard({
  leads,
  prospectCount,
  defaultDealValue,
  currentUserId,
}: {
  leads: BoardRow[];
  prospectCount: number;
  defaultDealValue: number;
  currentUserId: string;
}) {
  // The server prop is the seed; Realtime patches this copy in place.
  const [liveLeads, setLiveLeads] = useState(leads);
  const [prevLeads, setPrevLeads] = useState(leads);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (prevLeads !== leads) {
    setPrevLeads(leads);
    setLiveLeads(leads);
  }

  useEffect(() => {
    const supabase = createBrowserSupabase();

    const channel = supabase
      .channel("pipeline-board")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "leads" },
        (payload) => {
          const row = payload.new as BoardRow | null;
          if (!row?.id) return;

          setLiveLeads((current) => {
            const index = current.findIndex((lead) => lead.id === row.id);
            const archived = (row as { archived_at?: string | null }).archived_at;

            // A lead that moved back to prospect leaves the board the same way
            // an archived one does: it no longer has a card.
            if (archived || !qualifies(row)) {
              return index === -1 ? current : current.filter((l) => l.id !== row.id);
            }
            if (index === -1) return [row, ...current];
            const next = [...current];
            next[index] = { ...next[index], ...row };
            return next;
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  function move(leadId: string, stage: PipelineStage) {
    setError(null);
    startTransition(async () => {
      const result = await setStage(leadId, stage);
      if (!result.ok) setError(result.error ?? "That move did not stick.");
    });
  }

  const byColumn = new Map<BoardColumn, BoardRow[]>();
  for (const column of BOARD_COLUMNS) byColumn.set(column, []);
  for (const lead of liveLeads) {
    byColumn.get(columnFor(lead))?.push(lead);
  }

  // Overdue first, then whatever is due soonest, then most recently touched.
  // The point of the board is to make the thing you should do next obvious.
  for (const rows of byColumn.values()) {
    rows.sort((a, b) => {
      if (a.next_action_at && b.next_action_at) {
        return a.next_action_at.localeCompare(b.next_action_at);
      }
      if (a.next_action_at) return -1;
      if (b.next_action_at) return 1;
      return b.status_updated_at.localeCompare(a.status_updated_at);
    });
  }

  const open = pipelineValue(liveLeads, defaultDealValue);
  const weighted = weightedValue(liveLeads, defaultDealValue);
  const won = wonValue(liveLeads, defaultDealValue);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-4 border-b border-[var(--color-line)] px-4 py-1.5 text-[var(--color-ink-3)]">
        <span>
          Open pipeline{" "}
          <span className="tabular text-[var(--color-ink)]">{formatMoney(open)}</span>
        </span>
        <span>
          Weighted{" "}
          <span className="tabular text-[var(--color-ink-2)]">
            {formatMoney(weighted)}
          </span>
        </span>
        <span>
          Won{" "}
          <span className="tabular text-[var(--color-ok)]">{formatMoney(won)}</span>
        </span>
        {/* Prospect is excluded from every figure above: thousands of unworked
            leads at the default value is a number nobody believes. */}
        <span className="ml-auto">
          <span className="tabular">{prospectCount.toLocaleString()}</span> not yet
          replied
        </span>
      </div>

      {error && (
        <p
          role="alert"
          className="shrink-0 border-b border-[var(--color-line)] px-4 py-1.5 text-[var(--color-danger)]"
        >
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-x-auto">
        <div className="flex h-full min-w-max gap-2 p-2">
          {BOARD_COLUMNS.map((column) => {
            const rows = byColumn.get(column) ?? [];
            const isProspect = column === "prospect";
            const value = rows.reduce(
              (total, lead) => total + dealValue(lead, defaultDealValue),
              0,
            );

            return (
              <section
                key={column}
                className="flex h-full w-[240px] shrink-0 flex-col border border-[var(--color-line)] bg-[var(--color-surface)]"
              >
                <header className="flex shrink-0 items-baseline gap-2 border-b border-[var(--color-line)] px-2 py-1">
                  <span className={STAGE_TONE[column] ?? ""}>
                    {COLUMN_LABEL[column]}
                  </span>
                  <span className="tabular ml-auto text-[var(--color-ink-3)]">
                    {isProspect ? prospectCount.toLocaleString() : rows.length}
                  </span>
                  {!isProspect && rows.length > 0 && (
                    <span className="tabular text-[var(--color-ink-3)]">
                      {formatMoney(value)}
                    </span>
                  )}
                </header>

                <div className="min-h-0 flex-1 overflow-y-auto p-1">
                  {isProspect ? (
                    <p className="px-1 py-2 text-[var(--color-ink-3)]">
                      Everything the sequence still owns. They appear here once
                      somebody replies.
                    </p>
                  ) : rows.length === 0 ? (
                    <p className="px-1 py-2 text-[var(--color-ink-3)]">Empty.</p>
                  ) : (
                    rows.map((lead) => (
                      <Card
                        key={lead.id}
                        lead={lead}
                        defaultDealValue={defaultDealValue}
                        currentUserId={currentUserId}
                        pending={pending}
                        onMove={move}
                      />
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Card({
  lead,
  defaultDealValue,
  currentUserId,
  pending,
  onMove,
}: {
  lead: BoardRow;
  defaultDealValue: number;
  currentUserId: string;
  pending: boolean;
  onMove: (leadId: string, stage: PipelineStage) => void;
}) {
  const overdue = isOverdue(lead);
  const owner = !lead.claimed_by
    ? "pool"
    : lead.claimed_by === currentUserId
      ? "you"
      : "other";

  return (
    <article className="mb-1 border border-[var(--color-line)] bg-[var(--color-surface-2)] px-2 py-1.5">
      <Link
        href={{ pathname: "/leads", query: { lead: lead.id } }}
        className="block truncate text-[var(--color-ink)] hover:underline"
      >
        {lead.company_name ?? "Unnamed"}
      </Link>

      <p className="truncate text-[var(--color-ink-3)]">
        {owner}
        {lead.city ? ` · ${lead.city}` : ""}
        {lead.state ? `, ${lead.state}` : ""}
      </p>

      <p className="truncate text-[var(--color-ink-3)]">
        {lead.status} {relative(lead.status_updated_at)}
      </p>

      {lead.next_action && (
        <p
          className={
            "truncate " +
            (overdue ? "text-[var(--color-danger)]" : "text-[var(--color-warn)]")
          }
        >
          {overdue ? "⚠ " : ""}
          {lead.next_action}
          {lead.next_action_at ? ` · ${relative(lead.next_action_at)}` : ""}
        </p>
      )}

      <div className="mt-1 flex items-center gap-2">
        <span className="tabular text-[var(--color-ink-2)]">
          {formatMoney(dealValue(lead, defaultDealValue))}
        </span>

        {lead.terminal_outcome ? (
          <span className="ml-auto text-[var(--color-ink-3)]">closed</span>
        ) : (
          <select
            aria-label={`Stage for ${lead.company_name ?? "this lead"}`}
            value={lead.stage}
            disabled={pending}
            onChange={(event) =>
              onMove(lead.id, event.target.value as PipelineStage)
            }
            className="ml-auto border border-[var(--color-line)] bg-[var(--color-surface-3)] px-1 py-0.5 text-[var(--color-ink)] disabled:opacity-40"
          >
            {PIPELINE_STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {COLUMN_LABEL[stage]}
              </option>
            ))}
          </select>
        )}
      </div>
    </article>
  );
}
