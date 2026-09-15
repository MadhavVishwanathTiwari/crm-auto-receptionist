// Words standing in for a detail somebody meant to fill in.
//
// A written email is sent exactly as typed, and the guard that protects it only
// knows about {{variables}}. Two starter templates were written with the
// placeholder as a plain word instead -- "Hey Name", "Company's site", "forms,
// name." -- so the guard passed them and "Hey Name" was one Ctrl+Enter from a
// real prospect.
//
// This is a heuristic, which is why nothing refuses a send on it. The composer
// shows what it found and asks for a second press; the {{ }} check stays the
// only hard block, because a rule that guesses at wording will sooner or later
// be wrong about somebody's real sentence.
//
// Plain module with no imports: the composer runs it on every keystroke.

const STAND_IN = String.raw`(?:first\s*name|firstname|fname|name|company(?:\s*name)?|business\s*name)`;

const PATTERNS: RegExp[] = [
  // "Hey Name," "Hi name" "Dear First Name"
  new RegExp(String.raw`\b(?:hey|hi|hello|dear)\s+(?:first\s*name|firstname|fname|name)\b`, "gi"),
  // "while filling forms, name." -- a name slot closing a clause.
  new RegExp(String.raw`,\s*(?:first\s*name|name)(?=\s*[.!?,])`, "gi"),
  // A capitalised stand-in in the middle of a sentence: "on Company's site",
  // "I think Company would". At the start of a sentence it is just a word.
  /(?<=[a-z,;:]\s+)(?:Company Name|Business Name|First Name|Company|Name)(?:'s)?\b/g,
  // Slots in brackets: [Name], <company>, {first name}, (Company Name).
  new RegExp(String.raw`[\[<{(]\s*${STAND_IN}\s*[\]>})]`, "gi"),
  // Unmistakable leftovers.
  /\b(?:X{3,}|TBD|TODO)\b/g,
];

/**
 * The stand-in words in this text, as they appear, once each.
 *
 * {{variables}} are removed first: those are reported by the composer's own
 * leftover check, and `{{name}}` would otherwise be reported twice.
 */
export function placeholderWords(text: string): string[] {
  const scanned = text.replace(/\{\{[^}]*\}\}/g, " ");
  const found = new Set<string>();

  for (const pattern of PATTERNS) {
    for (const match of scanned.matchAll(pattern)) {
      const words = match[0].replace(/^[,\s]+/, "").trim();
      if (words) found.add(words);
    }
  }

  return [...found];
}
