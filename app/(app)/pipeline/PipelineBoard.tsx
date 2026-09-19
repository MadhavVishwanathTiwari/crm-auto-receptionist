"use client";

import Link from "next/link";
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
import { createBrowserSupabase, subscribeAsUser } from "@/lib/supabase/client";
import { formatCount, relativeTo } from "@/lib/time/format";

import { closeLead } from "../leads/actions";
import { TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/Badge";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { StatTile } from "@/components/ui/StatTile";
import { cn } from "@/lib/cn";
import {
  humanise,
  STAGE_TONE,
  STATUS_TONE,
  TONE_TEXT,
  toneFor,
} from "@/lib/ui/tones";
import { useViewerZone } from "../ViewerZone";
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
      );

    return subscribeAsUser(supabase, channel);
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
      <div className="flex shrink-0 items-center gap-8 border-b border-line bg-surface px-4 py-2.5">
        <StatTile label="Open pipeline" value={formatMoney(open)} size="sm" />
        <StatTile
          label="Weighted"
          value={formatMoney(weighted)}
          tone="muted"
          size="sm"
        />
        <StatTile label="Won" value={formatMoney(won)} tone="ok" size="sm" />
        {/* Prospect is excluded from every figure above: thousands of unworked
            leads at the default value is a number nobody believes. Cards in that
            column do not change this, because countsTowardPipeline still
            excludes the stage. */}
        <StatTile
          className="ml-auto text-right"
          label="Not yet replied"
          value={formatCount(prospectCount)}
          tone="muted"
          size="sm"
        />
      </div>

      {error && (
        <p
          role="alert"
          className="shrink-0 border-b border-line px-4 py-1.5 text-danger"
        >
          {error}
        </p>
      )}

      {/* Closing used to be confirmed by a bar pushed into the page above the
          board, which moved every column down by its own height at the moment
          you were reading it. */}
      <ConfirmDialog
        open={confirming !== null}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const target = confirming;
          setConfirming(null);
          if (target) commitClose(target);
        }}
        destructive
        pending={pending}
        title={`Close ${confirming?.lead.company_name ?? "this lead"} as ${confirming ? COLUMN_LABEL[confirming.outcome] : ""}?`}
        description="Closing cannot be undone from the app. A terminal outcome wins over every later event, so reopening would need a database change."
        confirmLabel="Yes, close it"
        cancelLabel="Leave it open"
      />

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
                className="flex h-full w-[248px] shrink-0 flex-col rounded-lg border border-line bg-surface"
              >
                <header className="shrink-0 border-b border-line px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 shrink-0 rounded-full bg-current",
                        TONE_TEXT[toneFor(STAGE_TONE, column)],
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate font-medium text-ink">
                      {COLUMN_LABEL[column]}
                    </span>
                    <span className="tabular shrink-0 rounded-sm bg-surface-3 px-1.5 text-xs text-ink-2">
                      {isProspect
                        ? `${rows.length} / ${formatCount(prospectCount)}`
                        : rows.length}
                    </span>
                  </div>
                  {/* Prospect must still never show a value, cards or not. */}
                  {!isProspect && rows.length > 0 && (
                    <p className="tabular mt-0.5 text-ink-3">
                      {formatMoney(value)}
                    </p>
                  )}
                </header>

                <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                  {rows.length === 0 ? (
                    <p className="px-1 py-6 text-center text-ink-3">Empty</p>
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
                    <p className="px-1 py-2 text-ink-3">
                      The {rows.length} most recently touched of{" "}
                      {formatCount(prospectCount)}. The rest are on{" "}
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
  // "3 days ago" from the moment the server rendered, not from now, so the
  // browser's hydration a second later reads the same words.
  const { renderedAt } = useViewerZone();
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
      className={cn(
        "mb-1.5 rounded-md border border-line bg-surface-2 px-2.5 py-2 shadow-sm",
        "transition-colors duration-(--duration-fast)",
        draggable && "cursor-grab hover:border-line-2 hover:bg-surface-3",
        dragging && "opacity-40",
      )}
    >
      {/* An <a> is natively draggable and would hijack the gesture with a URL
          payload, so the card never starts a drag when you grab the name. */}
      <Link
        href={{ pathname: "/leads", query: { lead: lead.id } }}
        draggable={false}
        className="block truncate font-medium text-ink hover:underline"
      >
        {lead.company_name ?? "Unnamed"}
      </Link>

      <p className="mt-0.5 truncate text-ink-3">
        {owner}
        {lead.city ? ` · ${lead.city}` : ""}
        {lead.state ? `, ${lead.state}` : ""}
      </p>

      <p className="mt-1">
        <Badge tone={toneFor(STATUS_TONE, lead.status)} variant="dot">
          {humanise(lead.status)}{" "}
          <span className="text-ink-3">
            {relativeTo(lead.status_updated_at, renderedAt)}
          </span>
        </Badge>
      </p>

      {lead.next_action && (
        <p
          className={cn(
            "mt-1 flex items-start gap-1 truncate",
            overdue ? "text-danger" : "text-warn",
          )}
        >
          {overdue && (
            <TriangleAlert size={11} className="mt-0.5 shrink-0" aria-label="Overdue" />
          )}
          <span className="truncate">
            {lead.next_action}
            {lead.next_action_at
              ? ` · ${relativeTo(lead.next_action_at, renderedAt)}`
              : ""}
          </span>
        </p>
      )}

      <div className="mt-2 flex items-center gap-2 border-t border-line pt-1.5">
        <span className="tabular font-medium text-ink-2">
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
          className="ml-auto cursor-pointer rounded-sm border border-line bg-surface-3 px-1 py-0.5 text-xs text-ink-2 hover:text-ink disabled:opacity-40"
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
