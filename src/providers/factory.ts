import { GeminiClient } from "./gemini.js";
import { AnthropicClient } from "./anthropic.js";
import { OpenAIClient } from "./openai.js";
import type { LLMClient } from "./client.js";

export type Provider = "gemini" | "anthropic" | "openai";

export function detectProvider(model: string): Provider {
  if (model.startsWith("claude-")) return "anthropic";
  if (
    model.startsWith("gpt-") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4")
  )
    return "openai";
  return "gemini";
}

/**
 * Returns true if the model has built-in reasoning/thinking capabilities,
 * making a separate `think` tool redundant.
 */
export function hasNativeThinking(model: string): boolean {
  // Gemini thinking models (e.g. gemini-3.1-flash-thinking, gemini-2.5-flash)
  if (/thinking/i.test(model)) return true;
  // Gemini 2.5+ models have native thinking enabled by default
  if (/gemini-2\.5/i.test(model) || /gemini-3/i.test(model)) return true;
  return false;
}

export function createClient(
  model: string,
  apiKey: string,
  options?: {
    includeUsage?: boolean;
    maxTokens?: number;
    provider?: Provider;
    baseUrl?: string;
    temperature?: number;
  },
): LLMClient {
  const provider = options?.provider ?? detectProvider(model);
  const baseUrl = options?.baseUrl;
  if (provider === "anthropic")
    return new AnthropicClient(apiKey, model, options?.maxTokens, baseUrl, options?.temperature);
  if (provider === "openai") return new OpenAIClient(apiKey, model, { ...options, baseUrl });
  return new GeminiClient(apiKey, model, options?.maxTokens, baseUrl, options?.temperature);
}
