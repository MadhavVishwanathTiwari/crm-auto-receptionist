import { Suspense } from "react";

import { requireOrgContext } from "@/lib/org";

import { PAGE, PAGE_HEADER } from "../ui";
import { ContactCardData } from "./ContactCardData";
import { ContactDirectory, type ContactRow } from "./ContactDirectory";

export const dynamic = "force-dynamic";

// The same cap and the same reasoning as /leads: two operators working a few
// thousand leads, one fetch, filtered and sorted in the browser.
const MAX_ROWS = 5000;

/** Matches the real card's chrome so nothing shifts when it arrives. */
function CardSkeleton() {
  return (
    <section
      aria-busy="true"
      className="flex h-full min-w-0 flex-1 flex-col border-l border-[var(--color-line)] bg-[var(--color-surface)]"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--color-line)] px-4 py-2">
        <span className="text-[var(--color-ink-3)]">Loading contact</span>
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

  const { data, error } = await supabase
    .from("leads")
    // One string literal, per the note on every other page: supabase-js parses
    // the select list as a template literal type and concatenating it collapses
    // the result to an error type.
    //
    // Exactly what the list renders plus what the search box filters on. The
    // socials, website and stage columns are on the card and are fetched with
    // it -- "do not select a column the screen does not render" applies to the
    // 5000-row query most of all.
    .select(
      "id, first_name, middle_name, last_name, name_suffix, title, company_name, work_email, phone, phone_e164, city, state, claimed_by, status, status_updated_at, next_action_at",
    )
    .is("archived_at", null)
    .limit(MAX_ROWS);

  return (
    <div className={PAGE}>
      <header className={PAGE_HEADER}>
        <h1 className="text-[var(--color-ink)]">Contacts</h1>
        <span className="text-[var(--color-ink-3)]">
          Who these people are and how to reach them. What the machine should do
          with them is on Leads.
        </span>
      </header>

      {error ? (
        <p role="alert" className="px-4 py-6 text-[var(--color-danger)]">
          Could not load contacts: {error.message}
        </p>
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
    </div>
  );
}
