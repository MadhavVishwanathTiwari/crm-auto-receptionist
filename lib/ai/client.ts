import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { serverEnv } from "@/lib/env";

// One client, built the first time something asks for one.
//
// Lazy because serverEnv() throws in the browser and the key is deliberately
// not `required`: a deployment with no key must still build, still render every
// screen, and still run every other job. The route reports the absence rather
// than the module throwing at import time.

let client: Anthropic | null = null;

export function anthropicIsConfigured(): boolean {
  return serverEnv().anthropicApiKey.trim() !== "";
}

export function getAnthropic(): Anthropic {
  if (client) return client;

  const apiKey = serverEnv().anthropicApiKey.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. See .env.example.");
  }

  client = new Anthropic({ apiKey });
  return client;
}
