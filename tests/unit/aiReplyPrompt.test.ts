import { describe, expect, it } from "vitest";

import { buildSystemPrompt, buildUserMessage } from "@/lib/ai/reply/prompt";

const BASE = {
  businessContext: "We build AI receptionists for home service businesses.",
  kbEntries: [
    { question: "How much is it?", answer: "497 a month, no setup fee." },
    { question: "How long to go live?", answer: "Two business days." },
  ],
  senderName: "Madhav",
  bookingUrl: "https://cal.com/madhav/intro",
  demoUrl: "https://autoreceptionist.io/sandbox/brightsmile",
};

describe("buildSystemPrompt", () => {
  it("carries the business context and every entry it was given", () => {
    const prompt = buildSystemPrompt(BASE);
    expect(prompt).toContain("AI receptionists for home service businesses");
    expect(prompt).toContain("497 a month");
    expect(prompt).toContain("Two business days");
  });

  it("names the operator everywhere the rules refer to them", () => {
    const prompt = buildSystemPrompt(BASE);
    expect(prompt).not.toContain("{SENDER}");
    expect(prompt).toContain("Madhav's AI assistant");
  });

  it("names the booking link and this lead's demo", () => {
    const prompt = buildSystemPrompt(BASE);
    expect(prompt).toContain("https://cal.com/madhav/intro");
    expect(prompt).toContain("https://autoreceptionist.io/sandbox/brightsmile");
  });

  it("says so when there is no demo, rather than leaving a gap to fill", () => {
    const prompt = buildSystemPrompt({ ...BASE, demoUrl: null });
    expect(prompt).toContain("Do not invent a link");
    expect(prompt).not.toContain("sandbox");
  });

  it("drops a blank entry rather than feeding it an empty answer", () => {
    const prompt = buildSystemPrompt({
      ...BASE,
      kbEntries: [{ question: "Anything?", answer: "   " }],
    });
    expect(prompt).toContain("empty");
  });

  it("tells it that it knows nothing when nobody has written the context", () => {
    const prompt = buildSystemPrompt({ ...BASE, businessContext: "   " });
    expect(prompt).toContain("you cannot answer any question about it");
  });

  it("is identical for two candidates in the same run, so it can be cached", () => {
    expect(buildSystemPrompt(BASE)).toBe(buildSystemPrompt({ ...BASE }));
  });
});

describe("buildUserMessage", () => {
  const lead = {
    companyName: "Bright Smile Dental",
    personName: "Dana Reyes",
    city: "Austin",
    state: "TX",
    website: "https://brightsmile.example",
    demoUrl: null,
  };

  it("carries the facts that exist and leaves out the ones that do not", () => {
    const message = buildUserMessage({
      lead: { ...lead, personName: null },
      transcript: [],
    });
    expect(message).toContain("Bright Smile Dental");
    expect(message).toContain("Austin, TX");
    expect(message).not.toContain("Person:");
  });

  it("marks each side of the thread and keeps the order", () => {
    const message = buildUserMessage({
      lead,
      transcript: [
        { direction: "us", at: "2026-09-18T14:00:00.000Z", subject: "Hi", text: "ours" },
        { direction: "them", at: "2026-09-19T09:00:00.000Z", subject: "Re: Hi", text: "theirs" },
      ],
    });
    expect(message.indexOf("--- US")).toBeLessThan(message.indexOf("--- THEM"));
    expect(message).toContain("theirs");
  });

  it("says the thread could not be read rather than showing nothing", () => {
    expect(buildUserMessage({ lead, transcript: [] })).toContain(
      "could not be read",
    );
  });
});
