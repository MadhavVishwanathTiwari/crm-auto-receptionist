import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { getModelClient, REPLY_MODEL } from "@/lib/ai/client";
import { totalInputTokens } from "@/lib/ai/reply/decide";

import { checkFirstTouch } from "./guard";
import {
  buildOutboundSystemPrompt,
  buildOutboundUserMessage,
  type OutboundLead,
  type OutboundSystemInput,
} from "./prompt";
import { OutboundDecisionSchema } from "./schema";

// The model call for a first touch, and the one seam the tests stub.
//
// Same model and same refusal handling as the reply assistant (see
// lib/ai/client.ts for why gpt-6-sol), and the same refusal to use
// `fallbacks`: an email in somebody's name that one model would not write is
// not one to hand to a second.
//
// One difference: a draft the guard refuses gets ONE more attempt, told
// exactly which rules it broke. The house rules are a narrow vocabulary (the
// loss-frame list, exactly one question mark) and a model that writes a good
// email which happens to say "missing out" without "missed" is worth a second
// try at a fraction of a cent. A second refusal is a `failed` row, never a send.

export interface WriteInput {
  system: OutboundSystemInput;
  lead: OutboundLead;
  websiteText: string | null;
}

export type WriteResult =
  | {
      kind: "written";
      subject: string;
      body: string;
      reason: string;
      model: string;
      inputTokens: number | null;
      outputTokens: number | null;
    }
  | { kind: "skipped"; reason: string; model: string; inputTokens: number | null; outputTokens: number | null }
  | { kind: "failed"; reason: string; retryable: boolean; inputTokens?: number | null; outputTokens?: number | null };

const MAX_ATTEMPTS = 2;

function add(a: number | null, b: number | null): number | null {
  return a == null && b == null ? null : (a ?? 0) + (b ?? 0);
}

export async function writeFirstTouch(input: WriteInput): Promise<WriteResult> {
  const system = buildOutboundSystemPrompt(input.system);
  let problems: string[] | undefined;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let model = REPLY_MODEL;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await getModelClient().messages.parse({
        model: REPLY_MODEL,
        max_tokens: 4000,
        thinking: { type: "adaptive" },
        output_config: { effort: "high", format: zodOutputFormat(OutboundDecisionSchema) },
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: buildOutboundUserMessage({
              lead: input.lead,
              websiteText: input.websiteText,
              problems,
            }),
          },
        ],
      });
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        return { kind: "failed", reason: "rate limited by the model API", retryable: true };
      }
      if (error instanceof Anthropic.APIConnectionError) {
        return { kind: "failed", reason: "could not reach the model API", retryable: true };
      }
      if (error instanceof Anthropic.APIError) {
        return {
          kind: "failed",
          reason: `model API error ${error.status ?? "?"}: ${error.message}`,
          retryable: (error.status ?? 0) >= 500,
        };
      }
      return { kind: "failed", reason: error instanceof Error ? error.message : String(error), retryable: true };
    }

    inputTokens = add(inputTokens, totalInputTokens(response.usage));
    outputTokens = add(outputTokens, response.usage?.output_tokens ?? null);
    model = response.model ?? model;

    if (response.stop_reason === "refusal") {
      return { kind: "failed", reason: "the model declined to write this one", retryable: false, inputTokens, outputTokens };
    }
    if (response.stop_reason === "max_tokens") {
      return { kind: "failed", reason: "the model ran out of output tokens mid-email", retryable: false, inputTokens, outputTokens };
    }

    const decision = response.parsed_output;
    if (!decision) {
      return { kind: "failed", reason: "the model's answer did not match the expected shape", retryable: false, inputTokens, outputTokens };
    }

    if (decision.action === "skip") {
      return { kind: "skipped", reason: decision.reason, model, inputTokens, outputTokens };
    }

    const subject = decision.subject?.trim() ?? "";
    const body = decision.body?.trim() ?? "";
    const check = checkFirstTouch(subject, body, { senderName: input.system.senderName });

    if (check.ok) {
      return { kind: "written", subject, body, reason: decision.reason, model, inputTokens, outputTokens };
    }

    problems = check.problems;
  }

  return {
    kind: "failed",
    reason: `the draft broke the house rules twice: ${problems?.join(" ")}`,
    retryable: false,
    inputTokens,
    outputTokens,
  };
}
