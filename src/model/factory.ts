import { GeminiClient } from "./gemini.js";
import { AnthropicClient } from "./anthropic.js";
import type { LLMClient } from "./client.js";
import type { Config } from "../state/config.js";

export type Provider = "gemini" | "anthropic";

export function detectProvider(model: string): Provider {
  if (model.startsWith("claude-")) return "anthropic";
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

export function createClient(model: string, config: Config): LLMClient {
  const provider = detectProvider(model);

  if (provider === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY ?? config.anthropicApiKey;
    if (!key) {
      throw new Error(
        "No Anthropic API key found. Set ANTHROPIC_API_KEY or run: opencli config --anthropic-api-key <key>",
      );
    }
    return new AnthropicClient(key, model);
  }

  const key = process.env.GEMINI_API_KEY ?? config.apiKey;
  if (!key) {
    throw new Error(
      "No Gemini API key found. Set GEMINI_API_KEY or run: opencli config --api-key <key>",
    );
  }
  return new GeminiClient(key, model);
}
