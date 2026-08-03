# Design: B6 — First-class OSS model support

_Status: Implemented — under review in [#297](https://github.com/zjshen14/opencli/pull/297); flip to `merged in <sha> (<date>)` on merge. Phase: [Roadmap B6](../roadmap.md). Tracking issue: [#296](https://github.com/zjshen14/opencli/issues/296)._

---

## Problem and goal

The B1 transport plumbing already shipped: `--provider`, `--base-url`, `config.provider` / `config.baseUrl`, and a generic chat-completions client in [`src/providers/openai.ts`](../../src/providers/openai.ts) with no OpenAI-specific wire assumptions. OSS models are therefore *reachable* today.

But nothing in the codebase **knows** about them. Provider identity, API-key resolution, context-window sizing, and thinking-capability detection are four independent hardcoded tables, each of which assumes the world contains exactly Gemini, Anthropic, and OpenAI. That produces four defects:

1. **Silent wrong-provider fallback.** `detectProvider()` returns `"gemini"` for any unrecognised model name, so `--model kimi-k3` constructs a *Gemini* client and fails confusingly.
2. **Context windows wrong in both directions.** `MODEL_CONTEXT_WINDOWS` has no OSS entries, so everything falls back to `DEFAULT_CONTEXT_WINDOW = 100_000`. Hosted OSS models (Kimi K3, GLM-5.2, DeepSeek V4, Qwen3.7-Max) ship **1M** windows — auto-compact fires 13× too early and destroys context for no reason. Local models are typically **much smaller** (a stock `qwen2.5-coder:14b` is 32 768) — auto-compact never fires and the model silently truncates. The second failure is the worse one: it is invisible.
3. **API-key collision.** `resolveApiKey()` is a hardcoded 3-way branch. Using Kimi today means putting a *Moonshot* key in `OPENAI_API_KEY`, which breaks the moment you also want real OpenAI.
4. **Redundant `think` tool.** `hasNativeThinking()` only matches Gemini patterns, so always-on-thinking models like Kimi K3 still get a `think` tool injected, wasting tokens and muddying tool selection.

**Goal:** `--provider ollama` and `--model glm-5.2` work out of the box, with correct key, URL, context window, and capabilities — and the four tables collapse into one.

**Priority: local (Ollama) first.** Local inference is the purest expression of Angle 1, has no API key and no spend, is fully testable in CI-adjacent dev environments, and surfaces the hardest correctness problems (see §4). Hosted OSS presets are a table-extension exercise once the registry exists.

---

## 1. The registry

One module, `src/providers/registry.ts`, owning provider presets and model metadata.

```ts
/** The wire format a provider speaks — selects which LLMClient implementation to construct. */
export type WireFormat = "openai" | "anthropic" | "gemini";

export interface ModelInfo {
  id: string;
  contextWindow: number;
  nativeThinking?: boolean;
}

export interface ProviderPreset {
  id: string;
  label: string;
  wire: WireFormat;
  /** Absent for first-party providers, which use their SDK's default endpoint. */
  baseUrl?: string;
  /** Checked in order; first hit wins. Empty for providers needing no auth (Ollama). */
  apiKeyEnv: string[];
  /** Placeholder sent when apiKeyEnv is empty — SDKs reject an empty string. */
  placeholderKey?: string;
  /** Static model table. May be empty for gateways/local, where models are dynamic. */
  models: ModelInfo[];
  /** Model-name prefixes that map to this provider via detectProvider(). */
  detectPrefixes?: string[];
  /** Promote JSON tool calls that leaked into message content. See §4. */
  salvageToolCalls?: boolean;
  /** Query the provider at runtime for installed models. See §3. */
  runtimeDiscovery?: "ollama";
}
```

`detectProvider()`, `contextWindowFor()`, `hasNativeThinking()`, and `resolveApiKey()` all become thin readers over this table. The existing prefix-matching semantics (longest-prefix-first) are preserved.

### Preset table

| Preset | Wire | Base URL | Key env | Notes |
|---|---|---|---|---|
| `gemini` | gemini | _(SDK default)_ | `GEMINI_API_KEY` | first-party |
| `anthropic` | anthropic | _(SDK default)_ | `ANTHROPIC_API_KEY` | first-party |
| `openai` | openai | _(SDK default)_ | `OPENAI_API_KEY` | first-party |
| `ollama` | openai | `http://localhost:11434/v1` | _(none)_ | runtime discovery; salvage |
| `moonshot` | openai | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` | `kimi-k3`, 1M, thinking always-on; salvage |
| `zai` | openai | `https://api.z.ai/api/coding/paas/v4` | `ZAI_API_KEY`, `Z_AI_API_KEY` | `glm-5.2`, 1M, MIT-licensed; salvage |
| `deepseek` | openai | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | `deepseek-v4-pro` / `-flash`, 1M; salvage |
| `dashscope` | openai | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` | `qwen3.7-max` / `-plus`, 1M; salvage |
| `openrouter` | openai | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | gateway; no static models; salvage |

**Salvage is on for every OSS/local preset and no first-party one.** Whether the hosted
OSS endpoints actually need it is **unverified** — we have no keys to test against, and
behaviour may vary per model and drift over time. Rather than guess, the default is chosen
on which error is recoverable:

- *Enabled but unnecessary* — bounded buffering (§4) plus a structurally tiny misfire risk,
  since a payload must be the entire response **and** name a tool that was offered.
- *Disabled but necessary* — the agent loop sees no calls and silently does nothing, which
  is the precise failure this milestone exists to fix.

We take the recoverable side. If a hosted endpoint is shown to always emit structured
calls, turning its flag off is a one-line change.

Context windows are sourced as of 2026-08-02 and carry a comment recording that date. They are a *default*, always overridable — see §5.

> **Note:** Z.ai also exposes an Anthropic-compatible endpoint at `https://api.z.ai/api/anthropic`. We route GLM through the OpenAI wire because that is the documented coding endpoint and avoids depending on Anthropic-specific block semantics we would then have to keep in sync. The Anthropic route is recorded here as a known alternative, not an implementation target.

---

## 2. Backwards compatibility

`Provider` is currently the closed union `"gemini" | "anthropic" | "openai"`, persisted in `~/.opencli/config.json` and validated in `resolveProvider()`. Widening it is source-compatible for existing configs — every current value remains valid — but the exhaustiveness guard in `resolveApiKey()` (the `const _: never = provider` trick) must be replaced, since the union is no longer closed over a small set.

Replacement: `resolveApiKey()` looks the preset up by id and throws a listing error if absent. The compile-time guard is traded for a runtime one, which is the right trade once providers are data rather than types. Validation error messages enumerate `Object.keys(PRESETS)` rather than a hardcoded string, so they stay correct automatically.

---

## 3. Ollama runtime model discovery

A static table cannot describe local models: the set is whatever the user has pulled, and the context window is per-model and further adjustable via Modelfile `num_ctx`.

`GET /api/tags` returns everything needed in a single unauthenticated call:

```jsonc
{ "models": [ {
  "model": "qwen2.5-coder:14b",
  "details": { "context_length": 32768, "family": "qwen2" },
  "capabilities": ["completion", "tools", "insert"]
} ] }
```

This is strictly better than `/api/show`, which nests the value under a family-prefixed key (`qwen2.context_length`) that must be discovered by suffix-scanning.

**Design:**
- Discovery is **best-effort and non-fatal**. Ollama not running must degrade to the static default, never crash the CLI.
- Results are cached for the process lifetime — one call per session, at agent construction.
- `capabilities` is used to **warn early** when a selected model lacks `tools`. An agent CLI is useless against a model that cannot call tools, and failing at construction with a clear message beats failing mid-turn with a confusing one.
- Discovery lives in `src/providers/ollama-discovery.ts` and is injected into the registry lookup, keeping `registry.ts` pure and synchronous.

---

## 4. Tool-call salvage (the thing that makes local actually work)

**Empirically verified against `qwen2.5-coder:14b` on Ollama 0.32.5.** The model advertises `"tools"` capability, and its chat template instructs it to wrap calls in `<tool_call>` tags:

> For each function call, return a json object with function name and arguments within `<tool_call></tool_call>` with NO other text.

The model instead emits **bare JSON with no wrapper**:

```json
{ "name": "ls", "arguments": { "path": "/tmp" } }
```

Ollama's parser looks for the `<tool_call>` tags, doesn't find them, and leaves the payload in `message.content` with `finish_reason: "stop"` and `tool_calls: null`. **This reproduces identically on both the native `/api/chat` and the OpenAI-compatible `/v1/chat/completions` endpoints**, which confirms it is a model instruction-following gap, not a bug in Ollama's OpenAI translation layer or in OpenCLI.

The agentic loop sees zero function calls and terminates the turn. Without handling this, local support connects successfully and then does nothing useful — the worst kind of feature.

**Design:** a salvage pass in the OpenAI client, enabled per-preset via `salvageToolCalls`, applied only when a turn produced **no** structured tool calls. It:

1. Strips `<tool_call>` / `</tool_call>` wrappers if present (handles partial template compliance).
2. Strips ```` ```json ```` fences (models add them despite instructions not to).
3. Parses the remainder as JSON; accepts a single object or an array of them.
4. Requires `name` to match a tool **actually offered in this request**, and `arguments` to be an object.
5. Promotes matches to `function_call` stream events with a synthetic id.

### What actually makes this safe

Be precise about this, because the obvious answer is wrong. The name-match check (step 4)
does **not** prevent a model from having an *illustrative* call executed. Verified against
the built code:

```
content: {"name":"bash","arguments":{"command":"rm -rf /tmp/x"}}   offered: [bash, read]
→ salvaged: [{"name":"bash","args":{"command":"rm -rf /tmp/x"}}]
```

That is a real tool with a real name, so step 4 passes it. Three other properties are what
actually contain the risk:

- **The whole-content requirement.** `parseCandidate()` bails unless the cleaned content
  *starts* with `{` or `[`, so any leading prose defeats salvage entirely. Verified:
  `"Sure, here is what a call looks like:\n{…}"` → `[]`. This is the real guard, and it is
  why the start-of-content check must not be relaxed into a "find JSON anywhere" scan.
- **The no-structured-calls precondition.** A model that called tools properly and also
  wrote JSON prose never has that prose reinterpreted.
- **The HITL confirmation gate.** A salvaged `bash` or `write` passes through
  `requiresConfirmation()` exactly like any other call. Salvage promotes an *intent*; it
  does not bypass approval.

Residual risk: a model whose entire response is a well-formed call for an offered tool,
intended as illustration, will be executed — subject to confirmation. That is the same
failure mode as a model genuinely deciding to call the tool, and it is not distinguishable
from one. We accept it.

Salvage is opt-in per provider (`ollama`, `openrouter` — see §1), so first-party providers
are entirely unaffected.

### Streaming cost

Salvage needs the full text before it can classify it, but buffering every response would
destroy streaming. The client holds output back only while it could still be a tool call,
releasing it the moment the content proves to be prose. Two bounds keep this honest:

- Content opening with `{` or `[` stays ambiguous indefinitely, so the buffer is capped at
  `MAX_SALVAGE_BUFFER` (32 KB). Past that it is no longer a plausible tool call and is
  released, restoring streaming for the rest of the turn. Sized to still admit a `write`
  call carrying a substantial file body.
- A fence (```` ```json ````) is not itself a decision — the classifier waits for the first
  character inside it, since models fence both tool calls and ordinary code blocks.

---

## 5. Config overrides

Static context windows are defaults, not facts — a user may run a 1M model behind a proxy that truncates, or raise `num_ctx` locally. Add an optional config field:

```jsonc
{ "modelOverrides": { "qwen2.5-coder:14b": { "contextWindow": 65536 } } }
```

Resolution order for context window, first hit wins:

1. `config.modelOverrides[model].contextWindow`
2. Ollama runtime discovery (when provider is `ollama`)
3. Static registry `ModelInfo.contextWindow`
4. `DEFAULT_CONTEXT_WINDOW` (100 000)

---

## 6. Out of scope

- **Architect/editor routing (B5).** Depends on B4 ([#63](https://github.com/zjshen14/opencli/issues/63), `AgentContext` as a serializable value type). The registry is a prerequisite for it, not a delivery of it.
- **Anthropic-wire OSS endpoints.** Recorded in §1; not implemented.
- **Per-provider prompt variants.** Belongs to B3 ([#39](https://github.com/zjshen14/opencli/issues/39)); local models likely need terser prompts, but that is a separate, measurable change.
- **`num_ctx` negotiation.** We read Ollama's context length; we do not try to raise it.

---

## 7. Test plan

- **Registry unit tests** — preset lookup, prefix detection ordering, key-env fallback chains, unknown-provider errors.
- **`contextWindowFor()`** — existing behaviour preserved for first-party models; OSS entries resolve correctly; override precedence per §5.
- **Ollama discovery** — mocked `fetch` at the HTTP boundary (per engineering practices: mock at system boundaries only); covers success, connection-refused, malformed JSON, and missing `context_length`.
- **Salvage layer** — bare JSON, `<tool_call>`-wrapped, fenced, array-of-calls, unmatched name (must *not* promote), non-JSON prose (must not promote), and structured-calls-present (must not run).
- **End-to-end** — a real agent turn against local `qwen2.5-coder:14b`, verifying a tool actually executes. Not a CI gate; documented as a manual verification step since it requires a local Ollama with a pulled model.
