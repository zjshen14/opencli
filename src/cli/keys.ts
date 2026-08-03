import type { Provider } from "../providers/factory.js";
import { getPreset, listProviderIds } from "../providers/registry.js";
import type { Config } from "../state/config.js";

/**
 * Config fields holding first-party keys. These predate the registry and are kept as
 * dedicated fields so existing ~/.opencli/config.json files keep working; newer
 * providers use the generic `providerApiKeys` map instead.
 */
const CONFIG_KEY_FIELDS: Record<string, keyof Config> = {
  gemini: "geminiApiKey",
  anthropic: "anthropicApiKey",
  openai: "openaiApiKey",
};

/**
 * Resolves the API key for a provider: the preset's environment variables in declared
 * order, then the config file, then a placeholder for providers needing no auth.
 *
 * Per-provider env vars are what stop OSS keys from colliding — before the registry,
 * using Kimi meant putting a Moonshot key in OPENAI_API_KEY, which broke the moment you
 * also wanted real OpenAI.
 */
export function resolveApiKey(provider: Provider, config: Config): string {
  const preset = getPreset(provider);
  if (!preset) {
    throw new Error(
      `Unknown provider '${provider}'. Valid values: ${listProviderIds().join(", ")}`,
    );
  }

  for (const envVar of preset.apiKeyEnv) {
    const value = process.env[envVar];
    if (value) return value;
  }

  const configField = CONFIG_KEY_FIELDS[provider];
  if (configField) {
    const value = config[configField];
    if (typeof value === "string" && value) return value;
  }

  const custom = config.providerApiKeys?.[provider];
  if (custom) return custom;

  // Local runtimes need no auth, but SDK clients reject an empty key.
  if (preset.placeholderKey) return preset.placeholderKey;

  const envList = preset.apiKeyEnv.join(" or ");
  throw new Error(
    `No ${preset.keyLabel ?? preset.label} API key found. Set ${envList}, ` +
      `or add it to ~/.opencli/config.json under providerApiKeys.${provider}`,
  );
}
