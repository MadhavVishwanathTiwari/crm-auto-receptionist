import { getOrgContext } from "@/lib/org";

import { ContactCard, type ContactDetail, type NoteRow } from "./ContactCard";

/**
 * The server half of the contact card.
 *
 * Two queries, both narrow. A separate component from the list so the list
 * paints as soon as it is ready rather than waiting on this, and so the wide
 * column set -- eight socials, the address parts -- is fetched for exactly one
 * lead instead of five thousand.
 */
export async function ContactCardData({ contactId }: { contactId: string }) {
  const context = await getOrgContext();
  if (!context) return null;

  const [contact, notes] = await Promise.all([
    context.supabase
      .from("leads")
      // One string literal, as everywhere else.
      .select(
        "id, company_name, first_name, middle_name, last_name, name_suffix, title, work_email, phone, phone_e164, website, city, state, postal_code, country_code, personal_linkedin, personal_instagram, personal_facebook, personal_twitter, company_linkedin, company_instagram, company_facebook, company_twitter, claimed_by, status, status_updated_at, stage, terminal_outcome, next_action, next_action_at",
      )
      .eq("id", contactId)
      .maybeSingle(),

    // Notes only, not the hundred-event timeline. Notes are the one thing this
    // screen writes, so without them "add a note" writes into a void; the
    // machine log is what the /leads drawer is for.
    context.supabase
      .from("lead_events")
      .select("id, occurred_at, payload")
      .eq("lead_id", contactId)
      .eq("type", "note")
      .order("occurred_at", { ascending: false })
      .limit(10),
  ]);

  if (!contact.data) {
    // Not found and belongs-to-another-org are indistinguishable under RLS, and
    // saying which would leak the difference.
    return (
      <section className="flex h-full min-w-0 flex-1 items-start border-l border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-6">
        <p className="text-[var(--color-ink-3)]">That contact is not available.</p>
      </section>
    );
  }

  return (
    <ContactCard
      contact={contact.data as unknown as ContactDetail}
      notes={(notes.data ?? []) as NoteRow[]}
      currentUserId={context.userId}
    />
  );
}
