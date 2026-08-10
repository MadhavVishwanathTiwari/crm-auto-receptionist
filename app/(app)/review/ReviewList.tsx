"use client";

import { useState, useTransition } from "react";

import { BUTTON, PANEL } from "../ui";
import { decideReview, type Decision } from "./actions";

export interface ReviewItem {
  id: string;
  match_kind: string;
  match_value: string;
  created_at: string;
  incoming: Record<string, unknown>;
  existing: {
    id: string;
    company_name: string | null;
    first_name: string | null;
    last_name: string | null;
    work_email: string | null;
    phone: string | null;
    website: string | null;
    city: string | null;
    state: string | null;
    status: string;
  } | null;
}

const MATCH_LABEL: Record<string, string> = {
  place_id: "same Google place",
  website_domain: "same website domain",
  phone: "same phone number",
  work_email: "same work email",
};

/** The fields worth comparing side by side; the rest is noise in a decision. */
const COMPARED = [
  ["company_name", "Company"],
  ["first_name", "First name"],
  ["last_name", "Last name"],
  ["work_email", "Work email"],
  ["phone", "Phone"],
  ["website", "Website"],
  ["city", "City"],
  ["state", "State"],
] as const;

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

export function ReviewList({ items }: { items: ReviewItem[] }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [working, setWorking] = useState<string | null>(null);

  function decide(reviewId: string, decision: Decision) {
    setError(null);
    setWorking(reviewId);
    startTransition(async () => {
      const result = await decideReview(reviewId, decision);
      if (!result.ok) setError(result.error ?? "That did not work.");
      setWorking(null);
    });
  }

  if (items.length === 0) {
    return (
      <p className="px-4 py-6 text-[var(--color-ink-3)]">
        Nothing waiting. Near-duplicates from an import land here.
      </p>
    );
  }

  return (
    <div className="space-y-4 p-4">
      {error && (
        <p role="alert" className={PANEL + " text-[var(--color-danger)]"}>
          {error}
        </p>
      )}

      {items.map((item) => {
        const busy = pending && working === item.id;
        return (
          <div key={item.id} className={PANEL}>
            <div className="mb-3 flex items-baseline gap-3">
              <span className="text-[var(--color-warn)]">
                {MATCH_LABEL[item.match_kind] ?? item.match_kind}
              </span>
              <span className="font-[family-name:var(--font-mono)] text-[var(--color-ink-2)]">
                {item.match_value}
              </span>
              <span className="ml-auto text-[var(--color-ink-3)]">
                {new Date(item.created_at).toLocaleString()}
              </span>
            </div>

            <table className="w-full border-collapse">
              <thead>
                <tr className="text-left text-[var(--color-ink-3)]">
                  <th className="w-40 py-1 font-normal">Field</th>
                  <th className="py-1 font-normal">
                    Existing lead
                    {item.existing && (
                      <span className="ml-2 text-[var(--color-ink-3)]">
                        ({item.existing.status.replace(/_/g, " ")})
                      </span>
                    )}
                  </th>
                  <th className="py-1 font-normal">Incoming row</th>
                </tr>
              </thead>
              <tbody>
                {COMPARED.map(([key, label]) => {
                  const existingValue = item.existing
                    ? (item.existing as unknown as Record<string, unknown>)[key]
                    : null;
                  const incomingValue = item.incoming[key];
                  const differs =
                    show(existingValue).toLowerCase() !==
                    show(incomingValue).toLowerCase();

                  return (
                    <tr key={key} className="border-t border-[var(--color-line)]">
                      <td className="py-1 text-[var(--color-ink-3)]">{label}</td>
                      <td className="py-1">{show(existingValue)}</td>
                      <td
                        className={
                          "py-1 " + (differs ? "text-[var(--color-warn)]" : "")
                        }
                      >
                        {show(incomingValue)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => decide(item.id, "inserted_anyway")}
                className={BUTTON}
              >
                Add as a separate lead
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => decide(item.id, "merged")}
                className={BUTTON}
              >
                Keep existing only
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => decide(item.id, "discarded")}
                className={BUTTON}
              >
                Discard
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
