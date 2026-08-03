/**
 * Provider + model registry — the single source of truth for which providers exist,
 * how to reach them, how to authenticate, and what their models can do.
 *
 * Before this module, four independent tables each assumed the world contained exactly
 * Gemini, Anthropic, and OpenAI: `detectProvider()`, `contextWindowFor()`,
 * `hasNativeThinking()`, and `resolveApiKey()`. Adding an OSS provider meant editing all
 * four, and forgetting one produced silent misbehaviour (see docs/design/b6-oss-models.md).
 *
 * This module has no I/O and no imports from other layers — it is pure data plus lookup
 * helpers, so it can be read from `core/`, `providers/`, and `cli/` without cycles.
 */

/** The wire format a provider speaks — selects which LLMClient implementation to construct. */
export type WireFormat = "openai" | "anthropic" | "gemini";

export interface ModelInfo {
  /** Matched as a *prefix* against the model name, longest match first. */
  id: string;
  contextWindow: number;
  /** Model reasons natively, making a separate `think` tool redundant. */
  nativeThinking?: boolean;
}

export interface ProviderPreset {
  id: string;
  /** Human-readable name for provider listings. */
  label: string;
  /** Short name used in API-key error messages. Defaults to `label`. */
  keyLabel?: string;
  wire: WireFormat;
  /** Absent for first-party providers, which use their SDK's default endpoint. */
  baseUrl?: string;
  /** Checked in order; first hit wins. Empty for providers needing no auth (Ollama). */
  apiKeyEnv: string[];
  /** Sent when `apiKeyEnv` is empty or unset — SDK clients reject an empty string. */
  placeholderKey?: string;
  /** Static model table. Empty for gateways and local runtimes, where models are dynamic. */
  models: ModelInfo[];
  /** Model-name prefixes routed to this provider by `detectProviderFromRegistry()`. */
  detectPrefixes?: string[];
  /** Promote JSON tool calls that leaked into message content. See design doc §4. */
  salvageToolCalls?: boolean;
  /** Query the provider at runtime for its installed models. See design doc §3. */
  runtimeDiscovery?: "ollama";
}

/**
 * `salvageToolCalls` is enabled for every OSS/local preset and no first-party one.
 *
 * Whether hosted OSS endpoints (Moonshot, Z.ai, DeepSeek, DashScope) need it is
 * unverified — we have no keys to test against, and their behaviour may differ per model
 * and change over time. The default is chosen on which error is recoverable: salvage
 * enabled but unnecessary costs bounded buffering (see MAX_SALVAGE_BUFFER) and carries a
 * structurally tiny misfire risk, because a payload must be the *entire* response AND
 * name a tool that was actually offered. Salvage disabled but necessary means the agent
 * loop sees no calls and silently does nothing — the exact failure this change exists to
 * fix. We take the recoverable side and revisit if a hosted endpoint proves it is moot.
 *
 * Context windows and model IDs verified 2026-08-02 against provider documentation.
 * These are *defaults* — always overridable via `config.modelOverrides`, since a proxy
 * may truncate a window or a local Modelfile may raise it.
 */
export const PRESETS: Record<string, ProviderPreset> = {
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    keyLabel: "Gemini",
    wire: "gemini",
    apiKeyEnv: ["GEMINI_API_KEY"],
    detectPrefixes: ["gemini-"],
    models: [
      { id: "gemini-1.5", contextWindow: 1_048_576 },
      { id: "gemini-2.0", contextWindow: 1_048_576 },
      { id: "gemini-2.5", contextWindow: 1_048_576, nativeThinking: true },
      { id: "gemini-3", contextWindow: 1_048_576, nativeThinking: true },
    ],
  },

  anthropic: {
    id: "anthropic",
    label: "Anthropic Claude",
    keyLabel: "Anthropic",
    wire: "anthropic",
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
    detectPrefixes: ["claude-"],
    // Claude exposes extended thinking via explicit API config rather than always-on,
    // so nativeThinking stays false and the `think` tool remains useful.
    models: [{ id: "claude-", contextWindow: 200_000 }],
  },

  openai: {
    id: "openai",
    label: "OpenAI",
    wire: "openai",
    apiKeyEnv: ["OPENAI_API_KEY"],
    detectPrefixes: ["gpt-", "o1", "o3", "o4"],
    models: [
      { id: "gpt-4.1", contextWindow: 128_000 },
      { id: "gpt-4o", contextWindow: 128_000 },
      // Mini/preview reasoning models have 128k; longest-prefix matching puts these
      // ahead of the bare o1/o3/o4 entries below.
      { id: "o1-mini", contextWindow: 128_000, nativeThinking: true },
      { id: "o1-preview", contextWindow: 128_000, nativeThinking: true },
      { id: "o3-mini", contextWindow: 128_000, nativeThinking: true },
      { id: "o4-mini", contextWindow: 128_000, nativeThinking: true },
      { id: "o1", contextWindow: 200_000, nativeThinking: true },
      { id: "o3", contextWindow: 200_000, nativeThinking: true },
      { id: "o4", contextWindow: 200_000, nativeThinking: true },
    ],
  },

  ollama: {
    id: "ollama",
    label: "Ollama (local)",
    keyLabel: "Ollama",
    wire: "openai",
    baseUrl: "http://localhost:11434/v1",
    // Ollama needs no auth, but the OpenAI SDK rejects an empty API key.
    apiKeyEnv: ["OLLAMA_API_KEY"],
    placeholderKey: "ollama",
    // Models are whatever the user has pulled — resolved at runtime, not from a table.
    models: [],
    runtimeDiscovery: "ollama",
    // Local models routinely emit tool calls as bare JSON in content rather than in the
    // structured tool_calls field. Verified against qwen2.5-coder:14b — see design doc §4.
    salvageToolCalls: true,
  },

  moonshot: {
    id: "moonshot",
    label: "Moonshot AI (Kimi)",
    keyLabel: "Moonshot",
    wire: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
    detectPrefixes: ["kimi-"],
    // Kimi K3 (2026-07-16): 1M context, thinking always on.
    models: [{ id: "kimi-k3", contextWindow: 1_000_000, nativeThinking: true }],
    salvageToolCalls: true,
  },

  zai: {
    id: "zai",
    label: "Z.ai (GLM)",
    keyLabel: "Z.ai",
    wire: "openai",
    // Z.ai also exposes an Anthropic-compatible endpoint at /api/anthropic; we use the
    // documented OpenAI coding endpoint. See design doc §1.
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    apiKeyEnv: ["ZAI_API_KEY", "Z_AI_API_KEY"],
    detectPrefixes: ["glm-"],
    // GLM-5.2 (2026-06-13): 1M context, MIT-licensed open weights.
    models: [
      { id: "glm-5.2", contextWindow: 1_000_000, nativeThinking: true },
      { id: "glm-5", contextWindow: 1_000_000 },
    ],
    salvageToolCalls: true,
  },

  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    wire: "openai",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: ["DEEPSEEK_API_KEY"],
    detectPrefixes: ["deepseek-"],
    // DeepSeek V4 (1.6T MoE Pro / 284B Flash): both default to 1M context.
    models: [
      { id: "deepseek-v4-pro", contextWindow: 1_000_000, nativeThinking: true },
      { id: "deepseek-v4-flash", contextWindow: 1_000_000, nativeThinking: true },
      { id: "deepseek-", contextWindow: 128_000 },
    ],
    salvageToolCalls: true,
  },

  dashscope: {
    id: "dashscope",
    label: "Alibaba DashScope (Qwen)",
    keyLabel: "DashScope",
    wire: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: ["DASHSCOPE_API_KEY"],
    detectPrefixes: ["qwen"],
    models: [
      { id: "qwen3.7-max", contextWindow: 1_000_000, nativeThinking: true },
      { id: "qwen3.7-plus", contextWindow: 1_000_000, nativeThinking: true },
      { id: "qwen3-coder", contextWindow: 1_000_000 },
      { id: "qwen3.6-flash", contextWindow: 1_000_000 },
    ],
    salvageToolCalls: true,
  },

  openrouter: {
    id: "openrouter",
    label: "OpenRouter (gateway)",
    keyLabel: "OpenRouter",
    wire: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: ["OPENROUTER_API_KEY"],
    // A gateway fronts hundreds of models under vendor-prefixed names; enumerating them
    // here would rot immediately. Users set contextWindow via config.modelOverrides.
    models: [],
    salvageToolCalls: true,
  },
};

/** Provider fallback when a model name matches no registered prefix. */
export const DEFAULT_PROVIDER = "gemini";

export const DEFAULT_CONTEXT_WINDOW = 100_000;

export function getPreset(id: string): ProviderPreset | undefined {
  return PRESETS[id];
}

export function listProviderIds(): string[] {
  return Object.keys(PRESETS);
}

export function isKnownProvider(id: string): boolean {
  return id in PRESETS;
}

/**
 * Maps a model name to a provider id via registered prefixes, longest match first so
 * that a specific prefix always beats a more general one.
 *
 * Returns DEFAULT_PROVIDER for unrecognised names. That fallback predates the registry
 * and is preserved deliberately: changing it would break users who point a custom
 * `--base-url` at a Gemini-compatible proxy using a non-Gemini model name.
 */
export function detectProviderFromRegistry(model: string): string {
  let bestId = DEFAULT_PROVIDER;
  let bestLen = -1;

  for (const preset of Object.values(PRESETS)) {
    for (const prefix of preset.detectPrefixes ?? []) {
      if (model.startsWith(prefix) && prefix.length > bestLen) {
        bestId = preset.id;
        bestLen = prefix.length;
      }
    }
  }
  return bestId;
}

/**
 * Ollama-style `name:tag` (qwen2.5-coder:14b, llama3.1:8b, gpt-oss:20b). Hosted model
 * ids do not use a colon, so this is a reliable signal that a name is local.
 */
const LOCAL_NAME_RE = /^[^\s/:]+:[^\s/:]+$/;

export function looksLikeLocalModelName(model: string): boolean {
  return LOCAL_NAME_RE.test(model);
}

/**
 * Explains a provider guess when it is likely wrong, for the CLI to surface.
 *
 * Name-prefix detection cannot classify local models: their names are arbitrary, so
 * `llama3.1:8b` silently falls back to the default provider and `qwen2.5-coder:14b`
 * matches the hosted `qwen` prefix and routes to DashScope. Both then fail with an error
 * that says nothing about the real cause. The fallback itself is deliberate (see
 * `detectProviderFromRegistry`) — what was wrong was doing it silently.
 *
 * Returns undefined when detection is trustworthy.
 */
export function providerDetectionWarning(model: string, detected: string): string | undefined {
  if (looksLikeLocalModelName(model) && detected !== "ollama") {
    return (
      `Model '${model}' looks like a local Ollama model, but no provider was specified ` +
      `so it was routed to '${detected}'. If you meant to run it locally, pass --provider ollama.`
    );
  }

  const matchedAPrefix = Object.values(PRESETS).some((preset) =>
    (preset.detectPrefixes ?? []).some((prefix) => model.startsWith(prefix)),
  );
  if (!matchedAPrefix) {
    return (
      `Model '${model}' matches no known provider prefix; defaulting to '${detected}'. ` +
      `Pass --provider <${listProviderIds().join("|")}> if that is not what you want.`
    );
  }

  return undefined;
}

/**
 * Finds model metadata by longest-prefix match. When `providerId` is given, only that
 * provider's table is searched; otherwise every provider is searched, which is what
 * lets `contextWindowFor(model)` work without the caller knowing the provider.
 */
export function findModelInfo(model: string, providerId?: string): ModelInfo | undefined {
  const presets = providerId
    ? [PRESETS[providerId]].filter((p): p is ProviderPreset => p !== undefined)
    : Object.values(PRESETS);

  let best: ModelInfo | undefined;
  for (const preset of presets) {
    for (const info of preset.models) {
      if (model.startsWith(info.id) && info.id.length > (best?.id.length ?? -1)) {
        best = info;
      }
    }
  }
  return best;
}
