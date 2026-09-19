"use client";

import { CornerDownLeft, Search } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { searchLeads, type LeadHit } from "@/app/(app)/search";
import { Badge } from "@/components/ui/Badge";
import { Kbd } from "@/components/ui/Kbd";
import { cn } from "@/lib/cn";
import { onOpenPalette } from "@/lib/ui/palette";
import { humanise, STATUS_TONE, toneFor } from "@/lib/ui/tones";

import { NAV_ITEMS } from "./nav";

interface Row {
  key: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  badge?: React.ReactNode;
  go: Route;
}

/**
 * Jump anywhere, from anywhere.
 *
 * Fourteen screens is more than a person keeps in their head as a list of
 * places to click, and a lead you half-remember the name of used to mean
 * opening /leads and typing into a filter. Escape is consumed here rather than
 * allowed to bubble: the lead drawer and the contact card listen on window and
 * would otherwise navigate away behind the palette.
 */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<LeadHit[]>([]);
  const [active, setActive] = useState(0);
  const [searching, startSearch] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    const stop = onOpenPalette(() => setOpen(true));
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      stop();
    };
  }, []);

  // Reconciled during render rather than in an effect: a palette that clears
  // itself one render after it opens shows the previous search for a frame.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setHits([]);
      setActive(0);
    }
  }

  // Debounced, because this is a keystroke-per-round-trip to Tokyo otherwise.
  useEffect(() => {
    if (!open) return;
    const term = query.trim();
    if (term.length < 2) return;
    const timer = setTimeout(() => {
      startSearch(async () => setHits(await searchLeads(term)));
    }, 180);
    return () => clearTimeout(timer);
  }, [query, open]);

  const rows = useMemo<Row[]>(() => {
    const term = query.trim().toLowerCase();

    const screens: Row[] = NAV_ITEMS.filter(
      (item) => !term || item.label.toLowerCase().includes(term),
    ).map((item) => ({
      key: `nav:${item.href}`,
      label: item.label,
      hint: "Screen",
      icon: <item.icon size={14} strokeWidth={1.75} />,
      go: item.href,
    }));

    const leads: Row[] = hits.map((hit) => ({
      key: `lead:${hit.id}`,
      label: hit.company ?? hit.email ?? "Untitled lead",
      hint:
        [hit.city, hit.state].filter(Boolean).join(", ") ||
        hit.email ||
        undefined,
      icon: <Search size={14} strokeWidth={1.75} />,
      badge: (
        <Badge tone={toneFor(STATUS_TONE, hit.status)} variant="dot">
          {humanise(hit.status)}
        </Badge>
      ),
      go: `/leads?lead=${hit.id}` as Route,
    }));

    return [...screens, ...leads];
  }, [query, hits]);

  const [rowCount, setRowCount] = useState(rows.length);
  if (rowCount !== rows.length) {
    setRowCount(rows.length);
    setActive(0);
  }

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function choose(row: Row | undefined) {
    if (!row) return;
    setOpen(false);
    router.push(row.go);
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-overlay px-4 pt-[12vh]"
      onClick={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-[560px] overflow-hidden rounded-xl border border-line-2 bg-surface shadow-xl"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            // Consumed: the drawer and the contact card listen on window.
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((index) => (index + 1) % Math.max(1, rows.length));
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive(
              (index) =>
                (index - 1 + Math.max(1, rows.length)) %
                Math.max(1, rows.length),
            );
          }
          if (event.key === "Enter") {
            event.preventDefault();
            choose(rows[active]);
          }
        }}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-3.5">
          <Search size={15} className="shrink-0 text-ink-3" aria-hidden="true" />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(event) => {
              const next = event.target.value;
              setQuery(next);
              // Below the search floor there is nothing to show, and waiting
              // for the debounce to say so leaves stale rows on screen.
              if (next.trim().length < 2) setHits([]);
            }}
            placeholder="Jump to a screen, or search leads by company, email or city"
            aria-label="Search"
            className="h-11 min-w-0 flex-1 bg-transparent text-lg text-ink placeholder:text-ink-3 focus:outline-none"
          />
          <Kbd>Esc</Kbd>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1.5">
          {rows.length === 0 ? (
            <p className="px-3.5 py-6 text-center text-ink-3">
              {searching ? "Searching…" : "Nothing matches that."}
            </p>
          ) : (
            rows.map((row, index) => (
              <button
                key={row.key}
                type="button"
                data-index={index}
                onMouseMove={() => setActive(index)}
                onClick={() => choose(row)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2 text-left",
                  index === active ? "bg-accent-soft" : "hover:bg-surface-2",
                )}
              >
                <span
                  className={cn(
                    "shrink-0",
                    index === active ? "text-accent" : "text-ink-3",
                  )}
                >
                  {row.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ink">{row.label}</span>
                  {row.hint && (
                    <span className="block truncate text-ink-3">{row.hint}</span>
                  )}
                </span>
                {row.badge}
                {index === active && (
                  <CornerDownLeft
                    size={13}
                    className="shrink-0 text-ink-3"
                    aria-hidden="true"
                  />
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
