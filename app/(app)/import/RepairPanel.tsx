"use client";

import { Play, Wrench } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/cn";

/**
 * The shape all four repairs on this screen share.
 *
 * Each one is preview-then-apply against an admin-only RPC that defaults to a
 * dry run, and each one reports a bag of outcome counts plus a list of rows
 * worth reading before you commit. They were four files of the same 140 lines,
 * which is how three of them ended up with a slightly different apply-button
 * disabled rule and one of them printed its explanation with a different dash.
 *
 * What genuinely differs is the copy, the label on the apply button, and how a
 * row renders -- so those are the props.
 */
export interface RepairResult {
  ok: boolean;
  error?: string;
  dryRun: boolean;
  counts: Record<string, number>;
}

export function RepairPanel<T extends RepairResult>({
  title,
  description,
  tone,
  explain,
  run,
  applyLabel,
  emptyMessage,
  detail,
}: {
  title: string;
  description: ReactNode;
  /** Outcome key -> text colour class. */
  tone: Record<string, string>;
  /** Outcome key -> the sentence that says what it means. */
  explain: Record<string, string>;
  run: (dryRun: boolean) => Promise<T>;
  /** The apply button's label, or null when there is nothing to apply. */
  applyLabel: (result: T) => string | null;
  emptyMessage: string;
  /** The panel-specific list of rows, rendered under the counts. */
  detail?: (result: T) => ReactNode;
}) {
  const router = useRouter();
  const [result, setResult] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);

  async function go(dryRun: boolean) {
    setBusy(true);
    try {
      const next = await run(dryRun);
      setResult(next);
      if (!dryRun && next.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const apply = result?.ok && result.dryRun ? applyLabel(result) : null;

  return (
    <Card className="p-4">
      <h2 className="mb-2 text-xl font-semibold text-ink">{title}</h2>
      <p className="mb-3 max-w-[70ch] text-ink-3">{description}</p>

      <div className="flex items-center gap-2">
        <Button
          icon={<Play size={13} />}
          loading={busy}
          onClick={() => go(true)}
          disabled={busy}
        >
          Preview
        </Button>
        {apply && (
          <Button
            variant="primary"
            icon={<Wrench size={13} />}
            onClick={() => go(false)}
            disabled={busy}
          >
            {apply}
          </Button>
        )}
      </div>

      {result && !result.ok && (
        <p
          role="alert"
          className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-danger"
        >
          {result.error}
        </p>
      )}

      {result?.ok && (
        <div className="mt-3">
          {Object.keys(result.counts).length === 0 ? (
            <p className="text-ink-3">{emptyMessage}</p>
          ) : (
            <>
              <p className="mb-2 text-ink-2">
                {result.dryRun ? "Would apply:" : "Applied:"}
              </p>
              <ul className="tabular space-y-1">
                {Object.entries(result.counts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([outcome, count]) => (
                    <li key={outcome} className={cn(tone[outcome])}>
                      <span className="font-medium">{count}</span> {outcome}
                      {explain[outcome] && (
                        <span className="text-ink-3"> — {explain[outcome]}</span>
                      )}
                    </li>
                  ))}
              </ul>
            </>
          )}

          {detail?.(result)}
        </div>
      )}
    </Card>
  );
}

/** The "rows worth reading" block every panel puts under its counts. */
export function RepairRows({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-3 border-t border-line pt-3">
      <p className="mb-2 text-ink-2">{label}</p>
      <ul className="tabular space-y-1 text-ink-3">{children}</ul>
    </div>
  );
}
