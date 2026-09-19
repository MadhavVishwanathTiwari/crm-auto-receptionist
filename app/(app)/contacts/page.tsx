import { Suspense } from "react";

import { requireOrgContext } from "@/lib/org";
import { selectUpTo } from "@/lib/supabase/paginate";

import { ContactCardData } from "./ContactCardData";
import { ContactDirectory, type ContactRow } from "./ContactDirectory";

import { Page, PageHeader } from "@/components/ui/PageShell";
import { LoadError } from "@/components/ui/LoadError";

export const dynamic = "force-dynamic";

// The same cap and the same reasoning as /leads: two operators working a few
// thousand leads, one read in pages of 1000, filtered and sorted in the browser.
const MAX_ROWS = 5000;

/** Matches the real card's chrome so nothing shifts when it arrives. */
function CardSkeleton() {
  return (
    <section
      aria-busy="true"
      className="flex h-full min-w-0 flex-1 flex-col border-l border-line bg-surface"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2">
        <span className="text-ink-3">Loading contact</span>
      </header>
    </section>
  );
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ contact?: string }>;
}) {
  const { supabase, userId } = await requireOrgContext();
  const { contact: selectedId } = await searchParams;

  const { data, error } = await selectUpTo<ContactRow>(
    () =>
      supabase
        .from("leads")
        // One string literal, per the note on every other page: supabase-js
        // parses the select list as a template literal type and concatenating
        // it collapses the result to an error type.
        //
        // Exactly what the list renders plus what the search box filters on.
        // The socials, website and stage columns are on the card and are
        // fetched with it -- "do not select a column the screen does not
        // render" applies to the 5000-row query most of all.
        .select(
          "id, first_name, middle_name, last_name, name_suffix, title, company_name, work_email, phone, phone_e164, city, state, claimed_by, status, status_updated_at, next_action_at",
        )
        .is("archived_at", null)
        // Offset pages need a stable order or they overlap.
        .order("id"),
    MAX_ROWS,
  );

  return (
    <Page>
      <PageHeader
        title="Contacts"
        note="Who these people are and how to reach them. What the machine should do with them is on Leads."
      />

      {error ? (
        <LoadError what="contacts" message={error.message} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <ContactDirectory
            contacts={(data ?? []) as ContactRow[]}
            currentUserId={userId}
            selectedId={selectedId ?? null}
          />
          {selectedId && (
            // Streamed and double-keyed, copying /leads: the key has to be on
            // the boundary as well as the child, or React reuses the pending
            // Suspense state and the previous contact's card stays up while the
            // next one loads.
            <Suspense key={selectedId} fallback={<CardSkeleton />}>
              <ContactCardData key={selectedId} contactId={selectedId} />
            </Suspense>
          )}
        </div>
      )}
    </Page>
  );
}
