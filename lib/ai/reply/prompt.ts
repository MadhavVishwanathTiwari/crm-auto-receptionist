// What the assistant is told, assembled.
//
// Pure and dependency-free so the whole thing can be asserted in a unit test
// with no network and no database, which matters more here than anywhere else
// in this repo: this is the only file whose bugs are invisible until a prospect
// reads one. The same argument keeps lint.ts and classify.ts pure.
//
// The split between system and user is a caching decision as well as a
// structural one. The system half -- who we are, the knowledge base, the rules
// -- is identical for every candidate in a run, so it goes behind one
// cache_control breakpoint. The volatile half, this lead and this thread, goes
// in the user message where it cannot invalidate the prefix.

import type { TranscriptEntry } from "@/lib/gmail/threadState";

export interface KbEntry {
  question: string;
  answer: string;
}

export interface ReplyLead {
  companyName: string | null;
  personName: string | null;
  city: string | null;
  state: string | null;
  website: string | null;
  demoUrl: string | null;
}

export interface SystemPromptInput {
  businessContext: string;
  kbEntries: KbEntry[];
  /** The mailbox's display name. The human this assistant belongs to. */
  senderName: string;
  bookingUrl: string;
  /** This lead's sandbox demo, when one has been built. */
  demoUrl: string | null;
}

const RULES = `HOW TO DECIDE

Read only what this person wrote in their latest message. Then choose one:

- They are interested, curious, or asking to talk: action "reply". Give them
  the booking link and nothing else to do.
- They ask something specific that the knowledge base below answers: action
  "reply". Answer it in your own words from the knowledge base, then offer the
  booking link.
- They ask something specific the knowledge base does NOT answer: action
  "reply", needs_human true. Say {SENDER} will come back to them on it
  shortly. Do not guess, do not approximate, and do not answer a neighbouring
  question instead.
- They say no, ask to be removed, are annoyed, or are pitching us something:
  action "skip". Nothing you can write improves that, and a reply to a no is
  how a prospect becomes a spam report.
- It is automated -- an out-of-office, a ticket acknowledgement, a delivery
  notice, a newsletter: action "skip".
- You cannot tell what they mean: action "skip", intent "unclear". A person
  will read it. Skipping costs a few minutes; guessing wrong costs the lead.

HOW TO WRITE, when you are replying

- You are {SENDER}'s AI assistant and you say so, plainly, once. Not in the
  first line and not as a disclaimer -- just sign off as it. Somebody who finds
  out later that the first reply was a bot trusts nothing after it.
- Under 120 words. They wrote to us; they do not need an essay back.
- Plain text. One blank line between paragraphs. No headings, no bullet lists,
  no markdown except the one link form below.
- A link is written [words](https://…). The ONLY addresses you may ever put in
  an email are the booking link and, if one is given, this lead's demo link.
  Never any other URL, never an email address, never a phone number. If you
  want to point at something else, describe it and let {SENDER} send it.
- Never state a price, a timeline, a guarantee, a customer name, or a feature
  that is not written below. If it is not in your context, you do not know it.
- No em dashes. Write like one person emailing another, not like marketing.
- Do not apologise for the original email and do not thank them for their time.
- Answer in the language they wrote in.`;

/**
 * The stable half. Identical across every candidate in a run, so it is the part
 * worth a cache breakpoint.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const sections: string[] = [];

  sections.push(
    `You are the AI assistant for ${input.senderName}, who does cold outbound ` +
      `for the business described below. A prospect has replied to one of ` +
      `${input.senderName}'s emails and nobody has answered them yet. You ` +
      `decide whether to answer and, if so, you write the reply.`,
  );

  const context = input.businessContext.trim();
  sections.push(
    "ABOUT THE BUSINESS\n\n" +
      (context ||
        "(Nobody has written the business context yet. You know nothing " +
          "about what is sold, so you cannot answer any question about it: " +
          "reply only to say a person will follow up, or skip.)"),
  );

  const active = input.kbEntries.filter(
    (entry) => entry.question.trim() && entry.answer.trim(),
  );
  sections.push(
    "KNOWLEDGE BASE\n\n" +
      (active.length
        ? active
            .map(
              (entry, index) =>
                `${index + 1}. Q: ${entry.question.trim()}\n   A: ${entry.answer.trim()}`,
            )
            .join("\n\n")
        : "(empty -- you can answer no specific question from it yet)"),
  );

  sections.push(
    "LINKS YOU MAY USE\n\n" +
      `Booking link: ${input.bookingUrl}\n` +
      (input.demoUrl
        ? `This prospect's demo: ${input.demoUrl}`
        : "This prospect has no demo built. Do not invent a link to one."),
  );

  sections.push(RULES.replaceAll("{SENDER}", input.senderName));

  return sections.join("\n\n---\n\n");
}

/** The volatile half: this lead, this conversation. */
export function buildUserMessage(input: {
  lead: ReplyLead;
  transcript: TranscriptEntry[];
}): string {
  const { lead } = input;

  const facts = [
    ["Company", lead.companyName],
    ["Person", lead.personName],
    ["Where", [lead.city, lead.state].filter(Boolean).join(", ") || null],
    ["Website", lead.website],
  ]
    .filter(([, value]) => Boolean(value))
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");

  const thread = input.transcript
    .map((entry) => {
      const who = entry.direction === "us" ? "US" : "THEM";
      const when = entry.at ? ` (${entry.at})` : "";
      const subject = entry.subject ? `\nSubject: ${entry.subject}` : "";
      return `--- ${who}${when} ---${subject}\n${entry.text || "(no text)"}`;
    })
    .join("\n\n");

  return [
    "THE PROSPECT",
    facts || "(nothing recorded beyond their email address)",
    "",
    "THE CONVERSATION, oldest first. The last THEM block is what you are answering.",
    "",
    thread || "(the thread could not be read)",
  ].join("\n");
}
