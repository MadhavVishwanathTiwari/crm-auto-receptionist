import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { serverEnv } from "@/lib/env";

// One client, built the first time something asks for one.
//
// Lazy because serverEnv() throws in the browser and the key is deliberately
// not `required`: a deployment with no key must still build, still render every
// screen, and still run every other job. The route reports the absence rather
// than the module throwing at import time.
//
// The model is reached through OpenRouter, which speaks the Anthropic Messages
// API at its own base URL and translates it for every model it serves:
// structured output, adaptive thinking and usage all come back in the same
// shape. So this is the Anthropic SDK talking to an OpenAI model, with a bearer
// token instead of an x-api-key.
//
// The model is gpt-6-sol: the most reliable of four on sixteen replies, each
// run twice through the real prompt and the real guard -- including a prompt
// injection, a discount ask, a half-answerable question, the wrong person, a
// vendor pitch, Spanish, "is this a bot" and "how did you get my email". Sol
// gave the same decision both times on every case and invented nothing, at
// about $0.004 a decision. Claude Sonnet 5 cost twice that and offered things
// we do not sell ("a live demo on your own number"); gpt-6-luna, at a twentieth
// of the price, promised "I'll reach out to Mike" in Madhav's name; Gemini 3.8
// Flash broke the JSON twice in 32; DeepSeek v4.1 Flash returned intents
// outside the schema. This is an email in a person's name, so the choice is
// reliability first and price second. Re-run the comparison before changing it.

const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

export const REPLY_MODEL = "openai/gpt-6-sol";

let client: Anthropic | null = null;

export function modelIsConfigured(): boolean {
  return serverEnv().openrouterKey.trim() !== "";
}

export function getModelClient(): Anthropic {
  if (client) return client;

  const authToken = serverEnv().openrouterKey.trim();
  if (!authToken) {
    throw new Error("OPENROUTER_KEY is not set. See .env.example.");
  }

  client = new Anthropic({ apiKey: null, authToken, baseURL: OPENROUTER_BASE_URL });
  return client;
}
