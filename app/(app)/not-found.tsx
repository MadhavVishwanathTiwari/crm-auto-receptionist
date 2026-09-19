import { Compass } from "lucide-react";
import Link from "next/link";

import { buttonClasses } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Page, PageHeader } from "@/components/ui/PageShell";

export default function NotFound() {
  return (
    <Page>
      <PageHeader title="Not found" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EmptyState
          icon={<Compass size={18} />}
          title="There is nothing at that address"
          body="The link may be stale, or the record it pointed at may have been archived."
          action={
            <Link href="/write" className={buttonClasses("primary", "md")}>
              Go to Write
            </Link>
          }
        />
      </div>
    </Page>
  );
}
