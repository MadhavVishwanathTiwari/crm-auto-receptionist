import { describe, expect, it } from "vitest";

import { totalInputTokens } from "@/lib/ai/reply/decide";

// The usage OpenRouter actually returned for a 1211-token cached system prompt.
describe("totalInputTokens", () => {
  it("counts the cached system prompt the first time, when it is written", () => {
    expect(
      totalInputTokens({
        input_tokens: 3,
        cache_creation_input_tokens: 1211,
        cache_read_input_tokens: 0,
      }),
    ).toBe(1214);
  });

  it("counts it on a cache hit, when it is read", () => {
    expect(
      totalInputTokens({
        input_tokens: 3,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 1211,
      }),
    ).toBe(1214);
  });

  it("says nothing rather than zero when there is no usage", () => {
    expect(totalInputTokens(null)).toBeNull();
    expect(totalInputTokens({ input_tokens: null })).toBeNull();
  });
});
