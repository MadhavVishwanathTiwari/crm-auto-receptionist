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
import {
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Inbox,
  SearchX,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input, Select } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { cn } from "@/lib/cn";
import { COLUMN_LABEL, columnFor, isOverdue } from "@/lib/pipeline/stages";
import { createBrowserSupabase, subscribeAsUser } from "@/lib/supabase/client";
import { formatCount, formatYours } from "@/lib/time/format";
import { useAction } from "@/lib/ui/useAction";
import { humanise, STAGE_TONE, STATUS_TONE, toneFor } from "@/lib/ui/tones";

import { useViewerZone } from "../ViewerZone";
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
  const { zone } = useViewerZone();
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
  const { run, pending } = useAction();
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" jumps to the search box, the way every list screen worth using does.
  // Ignored while you are already typing somewhere, so it can still be typed.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
          // A dot rather than a filled chip: fifteen coloured pills down a
          // dense grid is decoration, and globals.css is explicit that a
          // coloured cell here has to mean something.
          return (
            <Badge tone={toneFor(STATUS_TONE, value)} variant="dot">
              {humanise(value)}
            </Badge>
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
          <Badge
            tone={toneFor(STAGE_TONE, columnFor(info.row.original))}
            variant="dot"
          >
            {info.getValue<string>()}
          </Badge>
        ),
      },
      {
        id: "next_action",
        header: "Follow-up",
        size: 180,
        accessorFn: (row) => row.next_action ?? "",
        cell: (info) => {
          const row = info.row.original;
          if (!row.next_action) return <span className="text-ink-3">—</span>;
          const late = isOverdue(row);
          return (
            <span
              className={cn(
                "flex items-center gap-1",
                late ? "text-danger" : "text-warn",
              )}
            >
              {late && (
                <TriangleAlert size={12} className="shrink-0" aria-label="Overdue" />
              )}
              <span className="truncate">{row.next_action}</span>
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
          return value === "you" ? (
            <Badge tone="accent" variant="soft">
              you
            </Badge>
          ) : (
            <span className={value === "pool" ? "text-ink-3" : "text-ink-2"}>
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
            <Badge tone="warn" variant="soft">
              unresolved
            </Badge>
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
          formatYours(info.getValue<string>(), zone, "date"),
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
              <Button
                size="xs"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  run(() => claimLead(lead.id), {
                    success: `Claimed ${lead.company_name ?? "the lead"}`,
                  })
                }
              >
                Claim
              </Button>
            );
          }
          if (lead.claimed_by === currentUserId) {
            return (
              <Button
                size="xs"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  run(() => releaseLead(lead.id), {
                    success: "Released back to the pool",
                  })
                }
              >
                Release
              </Button>
            );
          }
          return null;
        },
      },
    ],
    [currentUserId, pending, zone, run],
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
      );

    return subscribeAsUser(supabase, channel);
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
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <Input
          ref={searchRef}
          type="search"
          placeholder="Search company, contact, email, city"
          aria-label="Search leads"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="w-[300px]"
        />

        <Select
          value={status}
          aria-label="Filter by status"
          onChange={(event) => setStatus(event.target.value)}
          className="w-[150px]"
        >
          <option value="all">All statuses</option>
          {statuses.map((value) => (
            <option key={value} value={value}>
              {humanise(value)}
            </option>
          ))}
        </Select>

        {/* Three visible choices rather than a <select>: the options here are
            the question the screen is actually for, and hiding them behind a
            click made "whose leads am I looking at" a thing you had to check. */}
        <SegmentedControl
          ariaLabel="Whose leads"
          value={ownership}
          onChange={setOwnership}
          options={[
            { value: "all", label: "Everyone" },
            { value: "mine", label: "Mine" },
            { value: "unclaimed", label: "Pool" },
          ]}
        />

        <Button
          variant="primary"
          icon={<Sparkles size={14} />}
          disabled={pending}
          loading={pending}
          onClick={() =>
            run(() => claimFromPool(25), {
              success: "Claimed up to 25 leads from the pool",
            })
          }
          className="ml-1"
        >
          Claim 25
        </Button>

        <span className="tabular ml-auto shrink-0 text-ink-3">
          <span className="text-ink">{formatCount(rows.length)}</span>
          {" of "}
          {formatCount(liveLeads.length)}
        </span>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div role="grid" aria-rowcount={rows.length} className="w-max min-w-full">
          <div
            role="row"
            className="sticky top-0 z-10 grid items-center border-b border-line-2 bg-surface-2"
            style={{
              gridTemplateColumns: templateColumns,
              height: "var(--header-height)",
            }}
          >
            {table.getHeaderGroups()[0]?.headers.map((header) => {
              const sortable = header.column.getCanSort();
              const sorted = header.column.getIsSorted();
              return (
                <button
                  key={header.id}
                  type="button"
                  disabled={!sortable}
                  onClick={header.column.getToggleSortingHandler()}
                  aria-sort={
                    sorted === "asc"
                      ? "ascending"
                      : sorted === "desc"
                        ? "descending"
                        : undefined
                  }
                  className={cn(
                    "group flex h-full items-center gap-1 px-2 text-left text-xs font-medium tracking-wide uppercase",
                    "disabled:cursor-default",
                    sorted ? "text-ink" : "text-ink-3",
                    sortable && "cursor-pointer hover:text-ink",
                  )}
                >
                  <span className="truncate">
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
                    )}
                  </span>
                  {sortable &&
                    (sorted === "asc" ? (
                      <ChevronUp size={12} className="shrink-0" />
                    ) : sorted === "desc" ? (
                      <ChevronDown size={12} className="shrink-0" />
                    ) : (
                      <ChevronsUpDown
                        size={12}
                        className="shrink-0 opacity-0 group-hover:opacity-100"
                      />
                    ))}
                </button>
              );
            })}
          </div>

          {rows.length === 0 ? (
            liveLeads.length === 0 ? (
              <EmptyState
                icon={<Inbox size={18} />}
                title="No leads yet"
                body="Import a CSV and the grid fills up. Every column here comes from that file or from what the app did next."
                action={
                  <Button variant="primary" onClick={() => router.push("/import")}>
                    Import a CSV
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<SearchX size={18} />}
                title="No leads match those filters"
                body="Widen the search, or switch back to Everyone."
                compact
                action={
                  <Button
                    onClick={() => {
                      setSearch("");
                      setStatus("all");
                      setOwnership("all");
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            )
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
                    role="row"
                    aria-selected={selected}
                    onClick={() => router.push(`/leads?lead=${row.original.id}`)}
                    className={cn(
                      "absolute top-0 left-0 grid w-full cursor-pointer items-center border-b border-line",
                      selected
                        ? "bg-accent-soft"
                        : "hover:bg-surface-2",
                    )}
                    style={{
                      gridTemplateColumns: templateColumns,
                      height: ROW_HEIGHT,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <div
                        key={cell.id}
                        role="gridcell"
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
