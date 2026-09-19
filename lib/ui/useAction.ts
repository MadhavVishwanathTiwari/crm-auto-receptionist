"use client";

import { useCallback, useState, useTransition } from "react";

import { toast } from "./toast";

/** What every server action in this app returns. None throw, none redirect. */
export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface RunOptions {
  /** Toasted when the action succeeds. Omit for actions that speak for themselves. */
  success?: string;
  /** Prefix for the failure toast; the server's sentence becomes the detail. */
  failure?: string;
  onSuccess?: () => void;
  onError?: (message: string) => void;
}

/**
 * Runs a server action, reports what happened, and reports that it is running.
 *
 * Replaces the run() helper that was copied verbatim into LeadDrawer and
 * ContactCard, and the fourteen separate useTransition + useState<string|null>
 * pairs behind them. It keeps `error` as local state as well as toasting, so a
 * screen that wants the message inline can still render it while it migrates.
 */
export function useAction() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    (work: () => Promise<ActionResult>, options: RunOptions = {}) => {
      setError(null);
      startTransition(async () => {
        let result: ActionResult;
        try {
          result = await work();
        } catch (cause) {
          // A server action can still fail to reach the server at all.
          const message =
            cause instanceof Error ? cause.message : "That did not work.";
          setError(message);
          toast.error(options.failure ?? "Something went wrong", message);
          options.onError?.(message);
          return;
        }

        if (!result.ok) {
          const message = result.error ?? "That did not work.";
          setError(message);
          toast.error(options.failure ?? "Could not do that", message);
          options.onError?.(message);
          return;
        }

        if (options.success) toast.success(options.success);
        options.onSuccess?.();
      });
    },
    [],
  );

  return { run, pending, error, setError };
}
