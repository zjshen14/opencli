import { getPreset } from "../providers/registry.js";
import {
  getOllamaModels,
  findOllamaModel,
  toolSupportWarning,
} from "../providers/ollama-discovery.js";
import type { Config } from "../state/config.js";

export interface ResolveContextWindowResult {
  /** Undefined means "no better information than the static registry default". */
  contextWindow?: number;
  /** Non-fatal warnings for the CLI to surface (e.g. model cannot call tools). */
  warnings: string[];
}

/**
 * Resolves a model's context window ahead of the static registry table, first hit wins:
 *
 *   1. `config.modelOverrides[model].contextWindow`
 *   2. Ollama runtime discovery (local providers only)
 *   3. undefined — caller falls back to the registry default
 *
 * This is where defect #2's local half is actually fixed, so it lives in its own module
 * rather than inline in `index.ts`: the precedence chain — including the "discovery
 * unavailable" path that must NOT invent a number — is the part worth testing directly.
 *
 * Discovery failure is always non-fatal. Returning undefined lets the conservative
 * static default apply, which is the safe direction; inventing a large window would
 * silently disable auto-compact.
 */
export async function resolveContextWindow(
  model: string,
  provider: string,
  baseUrl: string | undefined,
  config: Config,
): Promise<ResolveContextWindowResult> {
  const warnings: string[] = [];

  const configured = config.modelOverrides?.[model]?.contextWindow;
  if (configured && configured > 0) return { contextWindow: configured, warnings };

  const preset = getPreset(provider);
  if (preset?.runtimeDiscovery !== "ollama") return { warnings };

  const models = await getOllamaModels(baseUrl ?? preset.baseUrl ?? "");
  if (models.length === 0) return { warnings };

  const warning = toolSupportWarning(models, model);
  if (warning) warnings.push(warning);

  return { contextWindow: findOllamaModel(models, model)?.contextWindow, warnings };
}
