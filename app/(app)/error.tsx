"use client";

import { RotateCw, TriangleAlert } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Page, PageHeader } from "@/components/ui/PageShell";

/**
 * The boundary this app never had.
 *
 * Before it, a throw anywhere in the fourteen routes -- loadWriteContext()
 * refusing a partial read, say -- showed Next's own overlay in development and
 * an empty frame in production. Neither says what to do next.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Page>
      <PageHeader title="Something broke" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EmptyState
          icon={<TriangleAlert size={18} className="text-danger" />}
          title="This screen could not be loaded"
          body={
            <>
              {error.message || "The server did not say why."}
              {error.digest && (
                <span className="mt-2 block text-xs text-ink-3">
                  Reference {error.digest}
                </span>
              )}
            </>
          }
          action={
            <Button
              variant="primary"
              icon={<RotateCw size={14} />}
              onClick={reset}
            >
              Try again
            </Button>
          }
        />
      </div>
    </Page>
  );
}
