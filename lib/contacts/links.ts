// Turning eight columns into a row of links.
//
// Presentation, not a rule. There is no database gate behind this and nothing
// else reads it. It is in lib/ because it is pure, and because the eight social
// columns arrive as bare handles in one Clay export and as full URLs in the
// next, and that normalisation is exactly the kind of thing worth having one
// copy of and a test for.
//
// leads.raw still holds whatever the import actually stored, so `raw` is
// carried through and shown on hover: a link that silently rewrites a value is
// harder to debug than one that admits what it started from.

export type SocialNetwork = "linkedin" | "instagram" | "facebook" | "twitter";
export type SocialScope = "personal" | "company";

export interface SocialLink {
  scope: SocialScope;
  network: SocialNetwork;
  /** "LinkedIn", "Instagram", ... */
  label: string;
  /** Always absolute. */
  href: string;
  /** What the import stored, before normalisation. */
  raw: string;
}

const LABEL: Record<SocialNetwork, string> = {
  linkedin: "LinkedIn",
  instagram: "Instagram",
  facebook: "Facebook",
  twitter: "X",
};

/**
 * Where a bare handle goes.
 *
 * LinkedIn is deliberately absent: a handle alone is ambiguous there -- /in/ is
 * a person and /company/ is a business, and guessing wrong produces a link to
 * somebody else. A LinkedIn value that is not already a URL is rendered as
 * text rather than as a wrong link.
 */
const HANDLE_BASE: Partial<Record<SocialNetwork, string>> = {
  instagram: "https://instagram.com/",
  facebook: "https://facebook.com/",
  twitter: "https://x.com/",
};

/**
 * The eight columns, named rather than indexed.
 *
 * Spelled out so a caller passes a lead straight in with no cast, and so
 * renaming one of these columns is a type error here rather than a link that
 * silently stops rendering. Taken as Partial by socialLinks, because a lead
 * that has only one of the eight is the normal case rather than the exception.
 */
export interface SocialColumns {
  personal_linkedin: string | null;
  personal_instagram: string | null;
  personal_facebook: string | null;
  personal_twitter: string | null;
  company_linkedin: string | null;
  company_instagram: string | null;
  company_facebook: string | null;
  company_twitter: string | null;
}

/** Personal first: the person is who you are looking at on this screen. */
const COLUMNS: {
  scope: SocialScope;
  network: SocialNetwork;
  column: keyof SocialColumns;
}[] = [
  { scope: "personal", network: "linkedin", column: "personal_linkedin" },
  { scope: "personal", network: "instagram", column: "personal_instagram" },
  { scope: "personal", network: "facebook", column: "personal_facebook" },
  { scope: "personal", network: "twitter", column: "personal_twitter" },
  { scope: "company", network: "linkedin", column: "company_linkedin" },
  { scope: "company", network: "instagram", column: "company_instagram" },
  { scope: "company", network: "facebook", column: "company_facebook" },
  { scope: "company", network: "twitter", column: "company_twitter" },
];

/** True for anything that already names a host, with or without a protocol. */
function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^(www\.)?[a-z0-9-]+\.[a-z]{2,}/i.test(value);
}

/**
 * One stored value as an absolute URL, or null if it cannot become one.
 *
 * Exported for the test, and because the same question comes up for `website`.
 */
export function socialHref(network: SocialNetwork, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (looksLikeUrl(trimmed)) return `https://${trimmed}`;

  const base = HANDLE_BASE[network];
  if (!base) return null;

  // A handle, with or without the @ people write in front of it.
  const handle = trimmed.replace(/^@+/, "");
  if (handle === "" || /\s/.test(handle)) return null;
  return base + handle;
}

/**
 * The social links this lead actually has, in a fixed order.
 *
 * Nulls and whitespace-only values are skipped, which is most of them: these
 * columns are around ninety percent empty on a scraped import, and that is the
 * reason they are a card line rather than eight grid columns.
 */
export function socialLinks(lead: Partial<SocialColumns>): SocialLink[] {
  const links: SocialLink[] = [];

  for (const { scope, network, column } of COLUMNS) {
    const raw = lead[column];
    if (typeof raw !== "string") continue;

    const href = socialHref(network, raw);
    if (!href) continue;

    links.push({ scope, network, label: LABEL[network], href, raw: raw.trim() });
  }

  return links;
}

/**
 * The company site as something clickable.
 *
 * leads.website is stored as the import supplied it, and website_domain is the
 * generated normalisation, so this only has to survive a missing protocol.
 */
export function websiteHref(website: string | null): string | null {
  const trimmed = (website ?? "").trim();
  if (trimmed === "") return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!looksLikeUrl(trimmed)) return null;
  return `https://${trimmed}`;
}

/**
 * The address to dial.
 *
 * phone_e164 is the generated column and is what a dialler wants; phone is what
 * the import wrote, and is the fallback for a number that would not normalise.
 */
export function telHref(
  lead: { phone_e164: string | null; phone: string | null },
): string | null {
  const value = (lead.phone_e164 ?? lead.phone ?? "").trim();
  if (value === "") return null;
  return `tel:${value.replace(/[^\d+]/g, "")}`;
}

/** First + middle + last + suffix, skipping whatever the import did not fill. */
export function displayName(lead: {
  first_name: string | null;
  middle_name?: string | null;
  last_name: string | null;
  name_suffix?: string | null;
}): string {
  return [lead.first_name, lead.middle_name, lead.last_name, lead.name_suffix]
    .map((part) => (part ?? "").trim())
    .filter((part) => part !== "")
    .join(" ");
}
