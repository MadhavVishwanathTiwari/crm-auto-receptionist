import { describe, expect, it } from "vitest";

import { placeholderWords } from "@/lib/write/placeholders";

// The two starter bodies as they were in the database (Sep 2026), before 0049.
// Neither contains a {{variable}}, so the composer's leftover check passed them.
const DROPPING_OFF =
  "Hey Name, I'd imagine some people drop off before they get through the form on Company's site to get in touch.\n\nYou could probably capture some of those leads by reducing the time between a question and an answer to basically zero.";

const CASUAL_PI =
  "I imagine people drop off while filling forms, name. I think Company would benefit from a low friction way to get answers and support.\n\nOpen to seeing a quick demo link?";

describe("placeholderWords", () => {
  it("finds the stand-ins in the starter that said 'Hey Name'", () => {
    const found = placeholderWords(DROPPING_OFF);
    expect(found).toContain("Hey Name");
    expect(found).toContain("Company's");
  });

  it("finds the stand-ins in the starter that said 'forms, name.'", () => {
    const found = placeholderWords(CASUAL_PI);
    expect(found).toContain("name");
    expect(found).toContain("Company");
  });

  it("finds bracketed slots and obvious leftovers", () => {
    expect(placeholderWords("Dear [Name], about <company name>.")).toEqual([
      "[Name]",
      "<company name>",
    ]);
    expect(placeholderWords("Call me on XXX")).toEqual(["XXX"]);
  });

  it("leaves {{variables}} to the leftover check", () => {
    expect(placeholderWords("Hey {{first_name}}, {{company_name}}'s site")).toEqual([]);
    expect(placeholderWords("Hi {{name}}")).toEqual([]);
  });

  it("does not flag real emails", () => {
    const real = [
      "Hey Chris, I noticed Way Cool Plumbing's site sends people to a form after hours.\n\nWorth a look, or not?",
      "Hi there, quick one about the calls nobody picks up at Desert Air.",
      "Name a time that works and I will send the demo over.",
      "Your company name came up when I was looking at HVAC shops in Tempe.",
      "Company culture aside, the phones are what cost you jobs.",
      "Thanks,\nMadhav",
      "Which is better for you, Tuesday or Thursday?",
    ];
    for (const body of real) expect(placeholderWords(body), body).toEqual([]);
  });
});
