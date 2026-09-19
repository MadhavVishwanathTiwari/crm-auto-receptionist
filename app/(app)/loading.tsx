// One skeleton for every page in the group.
//
// Every page here is `dynamic = "force-dynamic"`, so a navigation cannot be
// served from a cache and always waits on the server. Without a loading state
// Next has nothing to show while it waits, so the browser sits on the PREVIOUS
// page with no feedback at all — which reads as a dead click rather than as a
// slow one. That is most of why this app felt slow even on the requests that
// were not.
//
// Deliberately generic: the pages share a header and a dense body, and a
// per-page skeleton that guesses the wrong shape is worse than an honest one.

import { Page, PageHeader } from "@/components/ui/PageShell";
import { Skeleton, SkeletonRows } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <Page>
      <PageHeader title={<Skeleton className="h-5 w-40" />} />
      <div className="min-h-0 flex-1 overflow-hidden p-4">
        <SkeletonRows rows={18} />
      </div>
    </Page>
  );
}
