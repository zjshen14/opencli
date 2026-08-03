import { GeminiClient } from "./gemini.js";
import { AnthropicClient } from "./anthropic.js";
import { OpenAIClient } from "./openai.js";
import type { LLMClient } from "./client.js";
import {
  PRESETS,
  getPreset,
  detectProviderFromRegistry,
  findModelInfo,
  listProviderIds,
} from "./registry.js";

/**
 * Provider ids come from the registry rather than a closed union, so adding an OSS
 * provider is a data change instead of a type change. The three first-party ids are
 * spelled out so existing call sites keep their literal types and editor completion.
 */
export type Provider = "gemini" | "anthropic" | "openai" | (string & {});

export function detectProvider(model: string): Provider {
  return detectProviderFromRegistry(model);
}

/**
 * Returns true if the model has built-in reasoning/thinking capabilities,
 * making a separate `think` tool redundant.
 */
export function hasNativeThinking(model: string): boolean {
  // An explicitly named thinking variant wins regardless of registry entries.
  if (/thinking/i.test(model)) return true;
  return findModelInfo(model)?.nativeThinking ?? false;
}

const COMPACTION_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  gemini: "gemini-3.1-flash-lite-preview",
  openai: "gpt-4.1-mini",
};

/**
 * Picks a cheap model for context compaction. OSS and local providers have no reliable
 * cheap-tier equivalent, so they compact using the session model itself. The base URL
 * must be threaded through, or a local session would try to compact against a cloud
 * endpoint it has no key for.
 */
export function createCompactionClient(
  sessionModel: string,
  apiKey: string,
  options?: { provider?: Provider; baseUrl?: string },
): LLMClient {
  const provider = options?.provider ?? detectProvider(sessionModel);
  const model = COMPACTION_MODELS[provider] ?? sessionModel;
  return createClient(model, apiKey, { provider, baseUrl: options?.baseUrl });
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
    /** Non-fatal diagnostics sink, injected by the CLI. */
    onWarn?: (message: string) => void;
  },
): LLMClient {
  const providerId = options?.provider ?? detectProvider(model);
  const preset = getPreset(providerId);

  if (options?.provider !== undefined && preset === undefined) {
    throw new Error(
      `Unknown provider '${providerId}'. Valid values: ${listProviderIds().join(", ")}`,
    );
  }

  // An explicit --base-url always overrides the preset's default endpoint.
  const baseUrl = options?.baseUrl ?? preset?.baseUrl;
  const wire = preset?.wire ?? "gemini";

  if (wire === "anthropic") {
    return new AnthropicClient(apiKey, model, options?.maxTokens, baseUrl, options?.temperature);
  }
  if (wire === "openai") {
    return new OpenAIClient(apiKey, model, {
      includeUsage: options?.includeUsage,
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
      baseUrl,
      salvage: preset?.salvageToolCalls ?? false,
      onWarn: options?.onWarn,
    });
  }
  return new GeminiClient(apiKey, model, options?.maxTokens, baseUrl, options?.temperature);
}

export { PRESETS, getPreset, listProviderIds };
