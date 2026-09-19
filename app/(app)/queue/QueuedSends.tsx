"use client";

import { DateTime } from "luxon";
import { useState, useTransition } from "react";

import { formatYours } from "@/lib/time/format";

import { BUTTON_QUIET } from "../ui";
import { useViewerZone } from "../ViewerZone";
import { cancelSend } from "../write/actions";

import { Table, TD, TH, THead, TR } from "@/components/ui/Table";

import { toast } from "@/lib/ui/toast";

export interface QueuedSend {
  id: string;
  step_number: number;
  status: string;
  scheduled_at: string;
  /** Prospect-local wall clock, frozen at plan time. No offset. */
  scheduled_local: string;
  prospect_timezone: string;
  outcome_reason: string | null;
  /** Set when a person wrote this one. The subject is theirs, verbatim. */
  composed_subject: string | null;
  company: string | null;
}

/**
 * Everything booked and not yet gone, with the one control a human has over it.
 *
 * Cancelling is deliberately the only write here. A row that says `sent` has an
 * email behind it in somebody's inbox, and an editable queue would let the
 * timeline disagree with reality. Fixing the WORDS of a written email happens
 * on the composer, which keeps the slot; this only removes the send.
 */
export function QueuedSends({ sends }: { sends: QueuedSend[] }) {
  const { zone } = useViewerZone();
  const [rows, setRows] = useState(sends);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function cancel(id: string, company: string | null) {
    setError(null);
    if (
      !window.confirm(
        `Cancel the email queued for ${company ?? "this lead"}? The planner may book a template send in its place.`,
      )
    ) {
      return;
    }

    startTransition(async () => {
      const result = await cancelSend(id);
      if (result.ok) toast.success("Booked send cancelled");
      if (!result.ok) {
        setError(result.error ?? "That send could not be cancelled.");
        toast.error("Could not cancel it", result.error);
        return;
      }
      setRows((current) => current.filter((row) => row.id !== id));
    });
  }

  return (
    <>
      {error && (
        <p role="alert" className="mb-2 text-danger">
          {error}
        </p>
      )}

      <Table>
        <THead>
            <TH>Company</TH>
            <TH>Step</TH>
            <TH>Copy</TH>
            <TH>Your time</TH>
            <TH>Their time</TH>
            <TH>State</TH>
            <TH></TH>
          </THead>
        <tbody>
          {rows.map((send) => {
            const local = DateTime.fromISO(send.scheduled_local);
            const written = send.composed_subject !== null;

            return (
              <TR key={send.id}>
                <TD className="max-w-[240px] truncate">
                  {send.company ?? "—"}
                </TD>
                <TD className="tabular">T{send.step_number}</TD>
                <TD className="max-w-[280px] truncate">
                  {written ? (
                    <span className="text-ink-2">
                      <span className="text-info">written</span>{" "}
                      {send.composed_subject}
                    </span>
                  ) : (
                    <span className="text-ink-3">from a template</span>
                  )}
                </TD>
                <TD className="tabular text-ink-2">
                  {send.status === "blocked" ? "—" : formatYours(send.scheduled_at, zone)}
                </TD>
                <TD className="tabular text-ink-2">
                  {send.status === "blocked"
                    ? "—"
                    : `${local.toFormat("HH:mm")} ${send.prospect_timezone}`}
                </TD>
                <TD>
                  {send.status === "blocked" ? (
                    <span className="text-warn">
                      blocked: {send.outcome_reason ?? "no capacity"}
                    </span>
                  ) : (
                    <span className="text-ink-3">planned</span>
                  )}
                </TD>
                <TD className="text-right">
                  <button
                    type="button"
                    className={BUTTON_QUIET}
                    disabled={pending}
                    onClick={() => cancel(send.id, send.company)}
                  >
                    cancel
                  </button>
                </TD>
              </TR>
            );
          })}
        </tbody>
      </Table>

      {rows.length === 0 && (
        <p className="text-ink-3">Nothing booked.</p>
      )}
    </>
  );
}
