import type { Provider } from "../providers/factory.js";
import type { Config } from "../state/config.js";

export function resolveApiKey(provider: Provider, config: Config): string {
  if (provider === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY ?? config.anthropicApiKey;
    if (!key)
      throw new Error(
        "No Anthropic API key found. Set ANTHROPIC_API_KEY or run: opencli config --anthropic-api-key <key>",
      );
    return key;
  }
  if (provider === "openai") {
    const key = process.env.OPENAI_API_KEY ?? config.openaiApiKey;
    if (!key)
      throw new Error(
        "No OpenAI API key found. Set OPENAI_API_KEY or run: opencli config --openai-api-key <key>",
      );
    return key;
  }
  if (provider === "gemini") {
    const key = process.env.GEMINI_API_KEY ?? config.geminiApiKey;
    if (!key)
      throw new Error(
        "No Gemini API key found. Set GEMINI_API_KEY or run: opencli config --gemini-api-key <key>",
      );
    return key;
  }
  // Exhaustiveness guard — TypeScript will error here if a new Provider value is added
  // without updating this function.
  const _: never = provider;
  throw new Error(`Unknown provider: ${String(_)}`);
}
