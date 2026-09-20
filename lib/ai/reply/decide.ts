import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { getAnthropic } from "@/lib/ai/client";

import {
  buildSystemPrompt,
  buildUserMessage,
  type ReplyLead,
  type SystemPromptInput,
} from "./prompt";
import { ReplyDecisionSchema, type ReplyDecision } from "./schema";

import type { TranscriptEntry } from "@/lib/gmail/threadState";

// The one place this app talks to a model, and the one seam the tests stub.
//
// Everything that can be decided without spending money is decided before this
// is called -- the lead is closed, the address is not theirs, a person already
// answered, we have already answered once. Reaching here costs real tokens even
// when the answer is "say nothing", so the ordering in the route is not a
// style preference.
//
// No `fallbacks` parameter, which is a deliberate departure from the SDK's
// default advice. On a refusal the right move for an email going out in
// somebody's name is to stop and tell a person, not to quietly re-run the same
// request on a different model and send whatever comes back.

export const REPLY_MODEL = "claude-opus-5";

export interface DecideInput {
  system: SystemPromptInput;
  lead: ReplyLead;
  transcript: TranscriptEntry[];
}

export type DecideResult =
  | {
      ok: true;
      decision: ReplyDecision;
      model: string;
      inputTokens: number | null;
      outputTokens: number | null;
    }
  | { ok: false; reason: string; retryable: boolean };

export async function decideReply(input: DecideInput): Promise<DecideResult> {
  let response;

  try {
    response = await getAnthropic().messages.parse({
      model: REPLY_MODEL,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "high",
        format: zodOutputFormat(ReplyDecisionSchema),
      },
      // The stable half behind the breakpoint; the thread goes in the user
      // message, after it, where it cannot invalidate the prefix.
      system: [
        {
          type: "text",
          text: buildSystemPrompt(input.system),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: buildUserMessage({
            lead: input.lead,
            transcript: input.transcript,
          }),
        },
      ],
    });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return { ok: false, reason: "rate limited by the model API", retryable: true };
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return { ok: false, reason: "could not reach the model API", retryable: true };
    }
    if (error instanceof Anthropic.APIError) {
      const retryable = (error.status ?? 0) >= 500;
      return {
        ok: false,
        reason: `model API error ${error.status ?? "?"}: ${error.message}`,
        retryable,
      };
    }
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }

  // A safety decline. Not a failure to retry: it is a judgement about this
  // conversation, and a person should read it.
  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category ?? "unspecified";
    return {
      ok: false,
      reason: `the model declined to answer this one (${category})`,
      retryable: false,
    };
  }

  // Truncation. A half-written email that happens to pass every other guard is
  // the one failure that looks fine right up until the prospect reads it.
  if (response.stop_reason === "max_tokens") {
    return {
      ok: false,
      reason: "the model ran out of output tokens mid-answer",
      retryable: false,
    };
  }

  const decision = response.parsed_output;
  if (!decision) {
    return {
      ok: false,
      reason: "the model's answer did not match the expected shape",
      retryable: false,
    };
  }

  return {
    ok: true,
    decision,
    model: response.model ?? REPLY_MODEL,
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
  };
}
