/**
 * Runtime model discovery for Ollama.
 *
 * A static table cannot describe local models: the set is whatever the user has pulled,
 * and the context window is per-model and further adjustable via a Modelfile's `num_ctx`.
 * Getting this wrong is not cosmetic — a stock `qwen2.5-coder:14b` reports 32 768 tokens,
 * well under the 100 000 static default, so without discovery OpenCLI believes it has 3x
 * more room than it does and never compacts before the model silently truncates.
 *
 * `GET /api/tags` returns context length and capabilities for every installed model in a
 * single unauthenticated call. It is preferred over `/api/show`, which nests the value
 * under a family-prefixed key (e.g. `qwen2.context_length`) that must be suffix-scanned.
 *
 * Discovery is always best-effort: Ollama not running must degrade to static defaults,
 * never crash the CLI.
 */

export interface OllamaModel {
  name: string;
  contextWindow?: number;
  capabilities: string[];
}

/** Shape of the subset of `/api/tags` we depend on. */
interface TagsResponse {
  models?: {
    model?: string;
    name?: string;
    details?: { context_length?: number };
    capabilities?: string[];
  }[];
}

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Derives the Ollama REST root from the OpenAI-compatible base URL, which ends in `/v1`.
 * `/api/tags` lives at the server root, not under `/v1`.
 */
export function toOllamaApiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

/**
 * Fetches installed models. Returns an empty array on any failure — connection refused,
 * timeout, non-200, or malformed body — so callers can fall back to static defaults.
 */
export async function discoverOllamaModels(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<OllamaModel[]> {
  const root = toOllamaApiRoot(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${root}/api/tags`, { signal: controller.signal });
    if (!res.ok) return [];

    const body = (await res.json()) as TagsResponse;
    if (!Array.isArray(body?.models)) return [];

    return body.models
      .map((m): OllamaModel | undefined => {
        const name = m.model ?? m.name;
        if (!name) return undefined;
        const ctx = m.details?.context_length;
        return {
          name,
          contextWindow: typeof ctx === "number" && ctx > 0 ? ctx : undefined,
          capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
        };
      })
      .filter((m): m is OllamaModel => m !== undefined);
  } catch {
    // Ollama not running, unreachable, or returned junk — fall back to static defaults.
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Process-lifetime cache. Discovery runs once per session at agent construction; the set
 * of installed models does not meaningfully change mid-session.
 */
const cache = new Map<string, OllamaModel[]>();

export async function getOllamaModels(baseUrl: string): Promise<OllamaModel[]> {
  const cached = cache.get(baseUrl);
  if (cached) return cached;

  const models = await discoverOllamaModels(baseUrl);
  // Only cache successful discovery, so a transient failure (Ollama still starting up)
  // does not poison the whole session with an empty result.
  if (models.length > 0) cache.set(baseUrl, models);
  return models;
}

/** Test seam — discovery caches for the process lifetime, which would leak across tests. */
export function clearOllamaCache(): void {
  cache.clear();
}

export function findOllamaModel(models: OllamaModel[], name: string): OllamaModel | undefined {
  // Exact match first; then tolerate the omitted `:latest` tag that Ollama implies.
  return (
    models.find((m) => m.name === name) ??
    models.find((m) => m.name === `${name}:latest`) ??
    models.find((m) => m.name.split(":")[0] === name)
  );
}

/**
 * Returns a warning when the selected model cannot call tools. An agent CLI is useless
 * against such a model, and failing at construction with a clear message beats failing
 * mid-turn with a confusing one. Returns undefined when the model is unknown to us —
 * absence of evidence is not evidence of absence.
 */
export function toolSupportWarning(models: OllamaModel[], name: string): string | undefined {
  const model = findOllamaModel(models, name);
  if (!model || model.capabilities.length === 0) return undefined;
  if (model.capabilities.includes("tools")) return undefined;

  return (
    `Ollama model '${name}' does not advertise tool-calling support ` +
    `(capabilities: ${model.capabilities.join(", ")}). ` +
    `OpenCLI needs tools to run its agent loop; expect it to be unable to edit files or run commands. ` +
    `Try a tool-capable model such as qwen2.5-coder.`
  );
}
