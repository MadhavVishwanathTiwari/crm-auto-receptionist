"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { displayName } from "@/lib/contacts/links";
import { createBrowserSupabase } from "@/lib/supabase/client";

import { INPUT } from "../ui";

export interface ContactRow {
  id: string;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  name_suffix: string | null;
  title: string | null;
  company_name: string | null;
  work_email: string | null;
  phone: string | null;
  phone_e164: string | null;
  city: string | null;
  state: string | null;
  claimed_by: string | null;
  status: string;
  status_updated_at: string;
  next_action_at: string | null;
}

/** Must match --row-height in globals.css. */
const ROW_HEIGHT = 30;

type Ownership = "all" | "mine" | "unclaimed";
type Reach = "any" | "email" | "phone";
type Order = "name" | "recent";

// Alphabetical by default, which is the other half of what makes this read as a
// directory rather than as /leads with different columns: /leads defaults to
// created_at desc, because its question is "what came in and what should I do
// about it".
const COLLATOR = new Intl.Collator(undefined, { sensitivity: "base" });

/** The name to file this row under. */
function sortKey(contact: ContactRow): string {
  const last = (contact.last_name ?? "").trim();
  if (last !== "") return last;
  // A scraped business with no decision maker resolved yet still has to land
  // somewhere sensible rather than clumping at the end of the alphabet.
  return (contact.company_name ?? "").trim();
}

export function ContactDirectory({
  contacts,
  currentUserId,
  selectedId,
}: {
  contacts: ContactRow[];
  currentUserId: string;
  selectedId: string | null;
}) {
  const router = useRouter();

  const [liveContacts, setLiveContacts] = useState(contacts);
  const [prevContacts, setPrevContacts] = useState(contacts);
  const [search, setSearch] = useState("");
  const [ownership, setOwnership] = useState<Ownership>("all");
  const [reach, setReach] = useState<Reach>("any");
  const [order, setOrder] = useState<Order>("name");

  if (prevContacts !== contacts) {
    setPrevContacts(contacts);
    setLiveContacts(contacts);
  }

  // Realtime. The simplest of the app's three lead handlers: this page's query
  // has no stage, status or qualification filter, so archived_at is the only
  // thing that can evict a row. RLS is enforced per subscriber, so the channel
  // needs no org filter.
  useEffect(() => {
    const supabase = createBrowserSupabase();

    const channel = supabase
      .channel("contacts-directory")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "leads" },
        (payload) => {
          const row = payload.new as ContactRow | null;
          if (!row?.id) return;

          setLiveContacts((current) => {
            const index = current.findIndex((contact) => contact.id === row.id);
            const archived = (row as { archived_at?: string | null }).archived_at;

            if (archived) {
              return index === -1 ? current : current.filter((c) => c.id !== row.id);
            }
            if (index === -1) return [row, ...current];
            // Merge rather than replace: the push carries the whole row, but a
            // future narrower publication would not.
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

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();

    const filtered = liveContacts.filter((contact) => {
      if (ownership === "mine" && contact.claimed_by !== currentUserId) return false;
      if (ownership === "unclaimed" && contact.claimed_by !== null) return false;
      if (reach === "email" && !contact.work_email) return false;
      if (reach === "phone" && !contact.phone_e164 && !contact.phone) return false;
      if (!needle) return true;

      // phone_e164 is the one /leads does not search, and searching a number is
      // a directory action. leads.search (the GIN tsvector) is deliberately not
      // used: it omits title, phone and website, and to_tsvector tokenizes to
      // whole words, so "smi" would match nothing. A directory box is a
      // substring search.
      return [
        contact.first_name,
        contact.middle_name,
        contact.last_name,
        contact.company_name,
        contact.title,
        contact.work_email,
        contact.phone_e164,
        contact.city,
        contact.state,
      ].some((field) => field?.toLowerCase().includes(needle));
    });

    return filtered.sort((a, b) =>
      order === "recent"
        ? b.status_updated_at.localeCompare(a.status_updated_at)
        : COLLATOR.compare(sortKey(a), sortKey(b)),
    );
  }, [liveContacts, search, ownership, reach, order, currentUserId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <div className="flex w-[380px] shrink-0 flex-col border-r border-[var(--color-line)]">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-3 py-2">
        <input
          type="search"
          placeholder="Name, company, title, email, phone"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className={INPUT + " w-full"}
        />
        <select
          value={ownership}
          onChange={(event) => setOwnership(event.target.value as Ownership)}
          className={INPUT}
        >
          <option value="all">Everyone</option>
          <option value="mine">Mine</option>
          <option value="unclaimed">Unclaimed</option>
        </select>
        {/* Reachability is this screen's question. There is deliberately no
            status filter: that is the ops question and /leads owns it. */}
        <select
          value={reach}
          onChange={(event) => setReach(event.target.value as Reach)}
          className={INPUT}
        >
          <option value="any">Any contact</option>
          <option value="email">Has email</option>
          <option value="phone">Has phone</option>
        </select>
        <select
          value={order}
          onChange={(event) => setOrder(event.target.value as Order)}
          className={INPUT}
        >
          <option value="name">A to Z</option>
          <option value="recent">Recently touched</option>
        </select>
        <span className="tabular ml-auto text-[var(--color-ink-3)]">
          {rows.length} of {liveContacts.length}
        </span>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <p className="px-3 py-4 text-[var(--color-ink-3)]">Nobody matches that.</p>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const contact = rows[virtualRow.index];
              const name = displayName(contact);
              const selected = contact.id === selectedId;

              return (
                <button
                  key={contact.id}
                  type="button"
                  onClick={() =>
                    router.push(`/contacts?contact=${contact.id}`)
                  }
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: ROW_HEIGHT,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className={
                    "flex items-baseline gap-2 px-3 text-left hover:bg-[var(--color-surface-2)] " +
                    (selected ? "bg-[var(--color-surface-3)]" : "")
                  }
                >
                  <span className="truncate text-[var(--color-ink)]">
                    {name || contact.company_name || "Unnamed"}
                  </span>
                  {name && (
                    <span className="truncate text-[var(--color-ink-3)]">
                      {contact.company_name ?? ""}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
