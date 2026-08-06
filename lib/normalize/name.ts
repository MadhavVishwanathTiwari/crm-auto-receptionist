// Splitting a joined name into first/last.
//
// Clay emits `full_name` joined; the legacy outreach sheet has them split. The
// importer has to accept both, and the sample data already contains the awkward
// cases: "Darrel S. Deokielal" (middle initial) and suffixed professional names
// common in dental and trades ("... DDS", "... Jr.").
//
// There is no SQL counterpart to this one — it runs during import only, and
// nothing dedupes on a name.

const PREFIXES = new Set([
  "mr", "mrs", "ms", "miss", "mx", "dr", "prof", "rev", "sir", "fr",
]);

const SUFFIXES = new Set([
  "jr", "sr", "ii", "iii", "iv", "v",
  "md", "do", "dds", "dmd", "phd", "pe", "cpa", "esq", "rn", "np", "pa",
]);

// A particle starts a compound surname: "Jan van der Berg" has last name
// "van der Berg", not "Berg".
const PARTICLES = new Set([
  "van", "von", "de", "del", "della", "der", "den", "di", "da", "do", "dos",
  "du", "la", "le", "les", "ter", "ten", "bin", "ibn", "al", "st", "st.",
]);

export interface SplitName {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  suffix: string | null;
}

const EMPTY: SplitName = {
  firstName: null,
  middleName: null,
  lastName: null,
  suffix: null,
};

/** Strips trailing punctuation so "Jr." matches "jr" and "S." matches "s". */
function key(token: string): string {
  return token.toLowerCase().replace(/[.,]+$/, "");
}

export function splitFullName(input: string | null | undefined): SplitName {
  const raw = (input ?? "").replace(/\s+/g, " ").trim();
  if (raw === "") return EMPTY;

  // "Deokielal, Darrel S." — surname-first. Only treat the comma this way when
  // what follows is not a suffix, since "John Smith, Jr." uses a comma too.
  let working = raw;
  const commaAt = raw.indexOf(",");
  if (commaAt > 0) {
    const before = raw.slice(0, commaAt).trim();
    const after = raw.slice(commaAt + 1).trim();
    const afterIsSuffixOnly =
      after !== "" && after.split(" ").every((t) => SUFFIXES.has(key(t)));
    working = afterIsSuffixOnly ? `${before} ${after}` : `${after} ${before}`;
  }

  let tokens = working.split(" ").filter(Boolean);

  // Leading titles carry no name information.
  while (tokens.length > 1 && PREFIXES.has(key(tokens[0]!))) {
    tokens = tokens.slice(1);
  }

  // Trailing credentials. Collected in original order so "Jane Doe, DDS, PhD"
  // round-trips as "DDS PhD".
  const suffixTokens: string[] = [];
  while (tokens.length > 1 && SUFFIXES.has(key(tokens[tokens.length - 1]!))) {
    suffixTokens.unshift(tokens.pop()!);
  }
  const suffix =
    suffixTokens.length > 0
      ? suffixTokens.map((t) => t.replace(/,$/, "")).join(" ")
      : null;

  if (tokens.length === 0) return { ...EMPTY, suffix };
  if (tokens.length === 1) {
    return { firstName: tokens[0]!, middleName: null, lastName: null, suffix };
  }

  const firstName = tokens[0]!;
  const rest = tokens.slice(1);

  // A particle anywhere after the first token opens the surname.
  const particleAt = rest.findIndex((t) => PARTICLES.has(key(t)));
  if (particleAt !== -1) {
    return {
      firstName,
      middleName: particleAt > 0 ? rest.slice(0, particleAt).join(" ") : null,
      lastName: rest.slice(particleAt).join(" "),
      suffix,
    };
  }

  return {
    firstName,
    middleName: rest.length > 1 ? rest.slice(0, -1).join(" ") : null,
    lastName: rest[rest.length - 1]!,
    suffix,
  };
}
