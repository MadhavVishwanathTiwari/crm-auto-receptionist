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
  isWorked,
  moveFor,
  pipelineValue,
  type BoardColumn,
  type TerminalColumn,
  weightedValue,
  wonValue,
} from "@/lib/pipeline/stages";
import { createBrowserSupabase } from "@/lib/supabase/client";

import { closeLead } from "../leads/actions";
import { BUTTON, BUTTON_QUIET, STAGE_TONE } from "../ui";
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

/** What a drag carries. A card is identified by nothing but its id. */
const DRAG_TYPE = "text/plain";

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

  // The card under the cursor. Visual only: nothing reads it to decide a write.
  const [dragging, setDragging] = useState<string | null>(null);

  // A terminal drop writes nothing until this is confirmed. There is no reopen,
  // so the gesture and the commitment are deliberately not the same event.
  const [confirming, setConfirming] = useState<{
    lead: BoardRow;
    outcome: TerminalColumn;
  } | null>(null);

  // Covers the round trip so a dropped card does not snap back for 200ms. The
  // operator is in India and the hop is browser -> edge -> hnd1; a lagging
  // <select> is fine, a card that visibly rebounds reads as a failure.
  //
  // One entry, because a drag is one gesture and further drags are disabled
  // while `pending`. Applied at grouping time only and never merged into
  // liveLeads, so the number of sources of truth stays at two.
  const [pendingMove, setPendingMove] = useState<{
    id: string;
    column: BoardColumn;
  } | null>(null);

  if (prevLeads !== leads) {
    setPrevLeads(leads);
    setLiveLeads(leads);
    // A fresh server snapshot is authoritative for every card, so the overlay
    // is either already reflected in it or was wrong. Either way it has done
    // its job, which was covering the round trip and nothing more.
    setPendingMove(null);
  }

  // The Realtime push landed and the row is where it was dropped, so stop
  // overriding it. Also covers the row being archived out from under the drag,
  // and the other operator moving it somewhere else, in which case the overlay
  // is a lie and dropping it shows the truth sooner.
  if (pendingMove) {
    const row = liveLeads.find((lead) => lead.id === pendingMove.id);
    if (!row || columnFor(row) === pendingMove.column) setPendingMove(null);
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

            if (archived) {
              return index === -1 ? current : current.filter((l) => l.id !== row.id);
            }

            // Already on the board: patch it wherever it now belongs. This used
            // to evict any row falling back to prospect, which was right while
            // Prospect had no cards and is wrong now. A card dragged back to
            // Prospect would vanish under the operator's cursor.
            if (index !== -1) {
              const next = [...current];
              next[index] = { ...next[index], ...row };
              return next;
            }

            // New to the board. A worked lead earns a card, which is what makes
            // a reply appear under Engaged with nobody doing bookkeeping. A
            // prospect does not: the Prospect column is the top fifty of a much
            // larger set and this row is not known to be in it, so inserting it
            // would grow the column unboundedly through a dispatch run.
            return isWorked(row) ? [row, ...current] : current;
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  // Escape cancels a pending close. Listener only, no state set in the effect
  // body, so this is not the pattern the lint rule objects to.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirming(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * The one entry point for moving a card, whichever gesture asked.
   *
   * The drop handler calls it and the <select> calls it, and both route through
   * the same pure moveFor(), so the mouse path and the keyboard path cannot
   * reach different conclusions about the same destination.
   */
  function requestMove(leadId: string, column: BoardColumn) {
    const lead = liveLeads.find((l) => l.id === leadId);
    if (!lead) return;

    const move = moveFor(lead, column);
    if (move.kind === "none") return;

    // A close writes nothing yet. There is no reopen, so the gesture asks and
    // the confirm commits: the same two steps the drawer uses for the same
    // action.
    if (move.kind === "close") {
      setConfirming({ lead, outcome: move.outcome });
      return;
    }

    setError(null);
    setPendingMove({ id: leadId, column });
    startTransition(async () => {
      const result = await setStage(leadId, move.stage);
      if (!result.ok) {
        // Dropping the overlay is the rollback: the card goes back to wherever
        // columnFor() says it is.
        setPendingMove(null);
        setError(result.error ?? "That move did not stick.");
      }
    });
  }

  function commitClose(target: { lead: BoardRow; outcome: TerminalColumn }) {
    setError(null);
    setPendingMove({ id: target.lead.id, column: target.outcome });
    startTransition(async () => {
      const result = await closeLead(target.lead.id, target.outcome, "");
      if (!result.ok) {
        setPendingMove(null);
        setError(result.error ?? "That lead did not close.");
      }
    });
  }

  const byColumn = new Map<BoardColumn, BoardRow[]>();
  for (const column of BOARD_COLUMNS) byColumn.set(column, []);
  for (const lead of liveLeads) {
    const column = pendingMove?.id === lead.id ? pendingMove.column : columnFor(lead);
    byColumn.get(column)?.push(lead);
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
            leads at the default value is a number nobody believes. Cards in that
            column do not change this, because countsTowardPipeline still
            excludes the stage. */}
        <span className="ml-auto">
          <span className="tabular">{prospectCount.toLocaleString()}</span> not yet
          replied
        </span>
      </div>

      {confirming && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-4 py-1.5">
          <span className="text-[var(--color-ink)]">
            Close {confirming.lead.company_name ?? "this lead"} as{" "}
            <span className={STAGE_TONE[confirming.outcome] ?? ""}>
              {COLUMN_LABEL[confirming.outcome]}
            </span>
            ?
          </span>
          {/* The same sentence the drawer prints for the same action, so the app
              says one thing about what closing costs. */}
          <span className="text-[var(--color-ink-3)]">
            Closing cannot be undone from the app. A terminal outcome wins over
            every later event, so reopening would need a database change.
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              const target = confirming;
              setConfirming(null);
              commitClose(target);
            }}
            className={BUTTON + " text-[var(--color-danger)]"}
          >
            Yes, close it
          </button>
          <button
            type="button"
            onClick={() => setConfirming(null)}
            className={BUTTON_QUIET}
          >
            cancel
          </button>
        </div>
      )}

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
                onDragOver={(event) => {
                  // preventDefault is what makes an element a drop target at
                  // all. Without it the drop never fires.
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(null);
                  const leadId = event.dataTransfer.getData(DRAG_TYPE);
                  if (leadId) requestMove(leadId, column);
                }}
                className="flex h-full w-[240px] shrink-0 flex-col border border-[var(--color-line)] bg-[var(--color-surface)]"
              >
                <header className="flex shrink-0 items-baseline gap-2 border-b border-[var(--color-line)] px-2 py-1">
                  <span className={STAGE_TONE[column] ?? ""}>
                    {COLUMN_LABEL[column]}
                  </span>
                  <span className="tabular ml-auto text-[var(--color-ink-3)]">
                    {isProspect
                      ? `${rows.length} / ${prospectCount.toLocaleString()}`
                      : rows.length}
                  </span>
                  {/* Prospect must still never show a value, cards or not. */}
                  {!isProspect && rows.length > 0 && (
                    <span className="tabular text-[var(--color-ink-3)]">
                      {formatMoney(value)}
                    </span>
                  )}
                </header>

                <div className="min-h-0 flex-1 overflow-y-auto p-1">
                  {rows.length === 0 ? (
                    <p className="px-1 py-2 text-[var(--color-ink-3)]">Empty.</p>
                  ) : (
                    rows.map((lead) => (
                      <Card
                        key={lead.id}
                        lead={lead}
                        defaultDealValue={defaultDealValue}
                        currentUserId={currentUserId}
                        pending={pending}
                        frozen={confirming !== null}
                        dragging={dragging === lead.id}
                        onDragStateChange={setDragging}
                        onMove={requestMove}
                      />
                    ))
                  )}

                  {/* Only the shown slice is draggable, so say which slice. */}
                  {isProspect && prospectCount > rows.length && (
                    <p className="px-1 py-2 text-[var(--color-ink-3)]">
                      The {rows.length} most recently touched of{" "}
                      {prospectCount.toLocaleString()}. The rest are on{" "}
                      <Link href="/leads" className="underline">
                        Leads
                      </Link>
                      .
                    </p>
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
  frozen,
  dragging,
  onDragStateChange,
  onMove,
}: {
  lead: BoardRow;
  defaultDealValue: number;
  currentUserId: string;
  pending: boolean;
  frozen: boolean;
  dragging: boolean;
  onDragStateChange: (leadId: string | null) => void;
  onMove: (leadId: string, column: BoardColumn) => void;
}) {
  const overdue = isOverdue(lead);
  const closed = lead.terminal_outcome !== null;
  const owner = !lead.claimed_by
    ? "pool"
    : lead.claimed_by === currentUserId
      ? "you"
      : "other";

  // A closed lead has no legal move: there is no reopen, and Won -> Lost is a
  // second close_lead rather than a drag. Refused here as well as by moveFor.
  const draggable = !pending && !frozen && !closed;

  return (
    <article
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, lead.id);
        event.dataTransfer.effectAllowed = "move";
        onDragStateChange(lead.id);
      }}
      onDragEnd={() => onDragStateChange(null)}
      className={
        "mb-1 border border-[var(--color-line)] bg-[var(--color-surface-2)] px-2 py-1.5 " +
        (draggable ? "cursor-grab " : "") +
        (dragging ? "opacity-40" : "")
      }
    >
      {/* An <a> is natively draggable and would hijack the gesture with a URL
          payload, so the card never starts a drag when you grab the name. */}
      <Link
        href={{ pathname: "/leads", query: { lead: lead.id } }}
        draggable={false}
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

        {/* All eight columns, and the keyboard path to every one of them. The
            value is columnFor() rather than lead.stage, so a closed card reads
            its outcome instead of the stage it died at, which the old bare
            "closed" span could not say. */}
        <select
          aria-label={`Column for ${lead.company_name ?? "this lead"}`}
          value={columnFor(lead)}
          disabled={pending || frozen || closed}
          onChange={(event) => onMove(lead.id, event.target.value as BoardColumn)}
          className="ml-auto border border-[var(--color-line)] bg-[var(--color-surface-3)] px-1 py-0.5 text-[var(--color-ink)] disabled:opacity-40"
        >
          {BOARD_COLUMNS.map((column) => (
            <option key={column} value={column}>
              {COLUMN_LABEL[column]}
            </option>
          ))}
        </select>
      </div>
    </article>
  );
}
