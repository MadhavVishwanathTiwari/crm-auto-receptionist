"use client";

import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { COLUMN_LABEL, columnFor, isOverdue } from "@/lib/pipeline/stages";
import { createBrowserSupabase } from "@/lib/supabase/client";

import { BUTTON, BUTTON_QUIET, INPUT, STAGE_TONE, STATUS_TONE } from "../ui";
import { claimFromPool, claimLead, releaseLead } from "./actions";

export interface LeadRow {
  id: string;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  work_email: string | null;
  status: string;
  claimed_by: string | null;
  city: string | null;
  state: string | null;
  timezone: string | null;
  rating: number | null;
  reviews_count: number | null;
  lead_score: number | null;
  is_qualified: boolean;
  created_at: string;
  stage: string;
  terminal_outcome: string | null;
  next_action: string | null;
  next_action_at: string | null;
}

// Must match --row-height in globals.css exactly, or the virtualizer's scroll
// height drifts from what is actually rendered.
const ROW_HEIGHT = 30;

type Ownership = "all" | "mine" | "unclaimed";

export function LeadsGrid({
  leads,
  currentUserId,
  selectedLeadId = null,
}: {
  leads: LeadRow[];
  currentUserId: string;
  /** From `?lead=`. The drawer itself is rendered by the page, server-side. */
  selectedLeadId?: string | null;
}) {
  const router = useRouter();
  // The server prop is the seed; Realtime patches this copy in place.
  const [liveLeads, setLiveLeads] = useState(leads);
  const [prevLeads, setPrevLeads] = useState(leads);

  // Adjusting state during render, not in an effect. A fresh prop arrives on
  // every router.refresh() after an action, and reconciling it from an effect
  // both renders stale rows for a frame and trips the lint rule against
  // synchronous setState in effects.
  if (prevLeads !== leads) {
    setPrevLeads(leads);
    setLiveLeads(leads);
  }

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [ownership, setOwnership] = useState<Ownership>("all");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "created_at", desc: true },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? "That did not work.");
    });
  }

  const columns = useMemo<ColumnDef<LeadRow>[]>(
    () => [
      {
        id: "company_name",
        accessorKey: "company_name",
        header: "Company",
        size: 220,
        cell: (info) => info.getValue<string | null>() ?? "—",
      },
      {
        id: "contact",
        header: "Contact",
        size: 160,
        accessorFn: (row) =>
          [row.first_name, row.last_name].filter(Boolean).join(" "),
        cell: (info) => info.getValue<string>() || "—",
      },
      {
        id: "work_email",
        accessorKey: "work_email",
        header: "Work email",
        size: 240,
        cell: (info) => info.getValue<string | null>() ?? "—",
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        size: 110,
        cell: (info) => {
          const value = info.getValue<string>();
          return (
            <span className={STATUS_TONE[value] ?? ""}>
              {value.replace(/_/g, " ")}
            </span>
          );
        },
      },
      {
        // Status is what the machine did; stage is where the human thinks the
        // deal is. Both are on the grid because a lead can be `replied` and
        // parked in nurture, and neither column implies the other.
        id: "stage",
        header: "Stage",
        size: 110,
        accessorFn: (row) => COLUMN_LABEL[columnFor(row)] ?? row.stage,
        cell: (info) => (
          <span className={STAGE_TONE[columnFor(info.row.original)] ?? ""}>
            {info.getValue<string>()}
          </span>
        ),
      },
      {
        id: "next_action",
        header: "Follow-up",
        size: 180,
        accessorFn: (row) => row.next_action ?? "",
        cell: (info) => {
          const row = info.row.original;
          if (!row.next_action) return "—";
          return (
            <span
              className={
                isOverdue(row) ? "text-[var(--color-danger)]" : "text-[var(--color-warn)]"
              }
            >
              {isOverdue(row) ? "⚠ " : ""}
              {row.next_action}
            </span>
          );
        },
      },
      {
        id: "owner",
        header: "Owner",
        size: 90,
        accessorFn: (row) =>
          row.claimed_by === null
            ? "pool"
            : row.claimed_by === currentUserId
              ? "you"
              : "other",
        cell: (info) => {
          const value = info.getValue<string>();
          return (
            <span
              className={
                value === "you"
                  ? "text-[var(--color-info)]"
                  : value === "pool"
                    ? "text-[var(--color-ink-3)]"
                    : "text-[var(--color-ink-2)]"
              }
            >
              {value}
            </span>
          );
        },
      },
      {
        id: "location",
        header: "Location",
        size: 150,
        accessorFn: (row) => [row.city, row.state].filter(Boolean).join(", "),
        cell: (info) => info.getValue<string>() || "—",
      },
      {
        id: "timezone",
        accessorKey: "timezone",
        header: "Timezone",
        size: 150,
        cell: (info) => {
          const value = info.getValue<string | null>();
          // An unresolved zone is never scheduled, so it is a real problem the
          // grid has to show rather than an empty cell.
          return value ? (
            value
          ) : (
            <span className="text-[var(--color-warn)]">unresolved</span>
          );
        },
      },
      {
        id: "rating",
        accessorKey: "rating",
        header: "Rating",
        size: 60,
        cell: (info) => info.getValue<number | null>() ?? "—",
      },
      {
        id: "reviews_count",
        accessorKey: "reviews_count",
        header: "Reviews",
        size: 70,
        cell: (info) => info.getValue<number | null>() ?? "—",
      },
      {
        id: "lead_score",
        accessorKey: "lead_score",
        header: "Score",
        size: 60,
        cell: (info) => info.getValue<number | null>() ?? "—",
      },
      {
        id: "created_at",
        accessorKey: "created_at",
        header: "Added",
        size: 100,
        cell: (info) =>
          new Date(info.getValue<string>()).toLocaleDateString(),
      },
      {
        id: "actions",
        header: "",
        size: 90,
        enableSorting: false,
        cell: ({ row }) => {
          const lead = row.original;
          if (lead.claimed_by === null) {
            return (
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => claimLead(lead.id))}
                className={BUTTON_QUIET}
              >
                claim
              </button>
            );
          }
          if (lead.claimed_by === currentUserId) {
            return (
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => releaseLead(lead.id))}
                className={BUTTON_QUIET}
              >
                release
              </button>
            );
          }
          return null;
        },
      },
    ],
    [currentUserId, pending],
  );

  // Realtime. RLS is enforced per subscriber, so no org filter is needed on the
  // channel: a row the user cannot select is a row they are never pushed.
  //
  // Only INSERT and UPDATE are handled. Leads are never deleted — there is no
  // DELETE policy, they are archived — which is also why leads.replica_identity
  // is left at its default rather than paying FULL on every write.
  useEffect(() => {
    const supabase = createBrowserSupabase();

    const channel = supabase
      .channel("leads-grid")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "leads" },
        (payload) => {
          const row = payload.new as LeadRow | null;
          if (!row?.id) return;

          setLiveLeads((current) => {
            const index = current.findIndex((lead) => lead.id === row.id);
            // An archived lead leaves the grid the same way the server query
            // would have excluded it.
            if ((row as { archived_at?: string | null }).archived_at) {
              return index === -1
                ? current
                : current.filter((lead) => lead.id !== row.id);
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

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return liveLeads.filter((lead) => {
      if (status !== "all" && lead.status !== status) return false;
      if (ownership === "mine" && lead.claimed_by !== currentUserId) return false;
      if (ownership === "unclaimed" && lead.claimed_by !== null) return false;
      if (!needle) return true;
      return [
        lead.company_name,
        lead.first_name,
        lead.last_name,
        lead.work_email,
        lead.city,
        lead.state,
      ].some((field) => field?.toLowerCase().includes(needle));
    });
  }, [liveLeads, search, status, ownership, currentUserId]);

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const rows = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const statuses = useMemo(
    () => [...new Set(liveLeads.map((lead) => lead.status))].sort(),
    [liveLeads],
  );

  const templateColumns = table
    .getVisibleLeafColumns()
    .map((column) => `${column.getSize()}px`)
    .join(" ");

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-4 py-2">
        <input
          type="search"
          placeholder="Search company, contact, email, city"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className={INPUT + " w-[300px]"}
        />
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          className={INPUT}
        >
          <option value="all">All statuses</option>
          {statuses.map((value) => (
            <option key={value} value={value}>
              {value.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <select
          value={ownership}
          onChange={(event) => setOwnership(event.target.value as Ownership)}
          className={INPUT}
        >
          <option value="all">Everyone</option>
          <option value="mine">Mine</option>
          <option value="unclaimed">Unclaimed pool</option>
        </select>

        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => claimFromPool(25))}
          className={BUTTON + " ml-2"}
        >
          Claim 25 from pool
        </button>

        <span className="tabular ml-auto text-[var(--color-ink-3)]">
          {rows.length} of {liveLeads.length}
        </span>
      </div>

      {error && (
        <p
          role="alert"
          className="shrink-0 border-b border-[var(--color-line)] px-4 py-1 text-[var(--color-danger)]"
        >
          {error}
        </p>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div className="w-max min-w-full">
          <div
            className="sticky top-0 z-10 grid items-center border-b border-[var(--color-line-2)] bg-[var(--color-surface-2)]"
            style={{
              gridTemplateColumns: templateColumns,
              height: "var(--header-height)",
            }}
          >
            {table.getHeaderGroups()[0]?.headers.map((header) => (
              <button
                key={header.id}
                type="button"
                disabled={!header.column.getCanSort()}
                onClick={header.column.getToggleSortingHandler()}
                className="truncate px-2 text-left text-[var(--color-ink-3)] disabled:cursor-default"
              >
                {flexRender(
                  header.column.columnDef.header,
                  header.getContext(),
                )}
                {{ asc: " ↑", desc: " ↓" }[
                  header.column.getIsSorted() as string
                ] ?? ""}
              </button>
            ))}
          </div>

          {rows.length === 0 ? (
            <p className="px-4 py-6 text-[var(--color-ink-3)]">
              {liveLeads.length === 0
                ? "No leads yet. Import a CSV to get started."
                : "No leads match those filters."}
            </p>
          ) : (
            <div
              className="relative"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index];
                if (!row) return null;
                const selected = row.original.id === selectedLeadId;
                return (
                  <div
                    key={row.id}
                    onClick={() => router.push(`/leads?lead=${row.original.id}`)}
                    className={
                      "absolute top-0 left-0 grid w-full cursor-pointer items-center border-b border-[var(--color-line)] hover:bg-[var(--color-surface-2)] " +
                      (selected ? "bg-[var(--color-surface-3)]" : "")
                    }
                    style={{
                      gridTemplateColumns: templateColumns,
                      height: ROW_HEIGHT,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <div
                        key={cell.id}
                        className="truncate px-2"
                        // The claim/release buttons live in a cell. Without
                        // this, clicking one also opens the drawer behind it.
                        onClick={
                          cell.column.id === "actions"
                            ? (event) => event.stopPropagation()
                            : undefined
                        }
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
