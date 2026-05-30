# Design: A5 — /compact + /context

_Status: A5a Implemented — merged in dd5acbd (2026-05-17). A5b pending — blocked on real-session Phase 2 validation, tracked in [#113](https://github.com/zjshen14/opencli/issues/113). Tracking issue: [#26](https://github.com/zjshen14/opencli/issues/26). Phase: [Roadmap A5](../roadmap.md)._

---

## Problem and goal

`ContextManager.prune()` hard-drops old messages with `slice(-maxHistoryMessages)`. On long sessions the agent loses its original task description, early decisions, and file paths it already visited — causing drift and repeated work. Users have no way to see how full the context window is or to do anything about it before the drop happens silently.

**Goal:** give users manual control over context compaction via `/compact` and visibility via `/context`, then add smart auto-compaction after real-session validation.

---

## Execution plan — two phases

The feedback from the [design review](https://github.com/zjshen14/opencli/issues/26#issuecomment-4469196098) identified critical gaps in auto-compact logic (mid-task triggers, trajectory elongation risk, token estimation accuracy). Ship in two stages:

### **A5a — Manual context compaction (ready to implement)**
- User-triggered `/compact` command with structured LLM summary
- `/context` command showing token usage + percentage
- Core algorithm: tail-keep + error-signal extraction
- **No auto-compact.** Collects real-session data for Phase 2 validation.
- ~6 files, ~2 days to implement + test

### **A5b — Auto-compact with safety gates (design review complete, blocked on A5a)**
- Accurate token counting via provider APIs (not JSON.stringify hack)
- Auto-compact only after agent completes a full turn (blocks mid-task triggers)
- Config gate: `autoCompact: false` default; flip after A5a validation
- Threshold warnings when approaching 60% and 75%
- Original prompt preservation: keep first 2 messages verbatim
- Better compaction model failure handling
- ~8 files, ~3 days to implement + real-session integration tests

**Sequencing:**
1. A5a ships → users can manually `/compact` long sessions
2. Real sessions accumulate for 1–2 weeks → understand actual compaction value/cost/failures
3. A5b design refined with real data → estimate auto-compact safety
4. A5b implements and tests with real scenario replays
5. Auto-compact lands opt-in by default (config flag), flips on after validation

---

## Scope

### A5a (manual compaction)

| Item | Status |
|---|---|
| `/compact` — manual structured LLM summarization | ✓ Spec'd |
| `/context` — print estimated tokens vs. context window | ✓ Spec'd |
| Core compaction algorithm + unit tests | ✓ Spec'd |
| Cheap compaction model via provider selection | ✓ Spec'd |
| Auto-compact hook | ✗ Deferred to A5b |
| Token API integration | ✗ Deferred to A5b |
| Threshold warnings | ✗ Deferred to A5b |
| Persistent token bar in REPL footer | ✗ Deferred to A6 (UX rendering) |
| `--compaction-model` CLI flag | ✗ Deferred (config field is extension point) |

### A5b (auto-compact, post-A5a)

| Item | Status |
|---|---|
| Auto-compact with provider token APIs | TBD (design review) |
| Turn-boundary detection (no mid-task triggers) | TBD |
| Config gate `autoCompact: false` default | TBD |
| Original prompt preservation | TBD |
| Compaction failure handling | TBD |
| Threshold warnings + visibility | TBD |
| Real-session integration tests | TBD |

---

## Research grounding

Before specifying the algorithm, a survey of production agents and academic literature shaped the design decisions below. Key findings:

### What production agents do

| Agent | Trigger | Algorithm | Compaction model |
|---|---|---|---|
| Claude Code | ~98% of context window (tokens) | Full-history LLM summary with custom instructions; CLAUDE.md re-injected post-compaction | Same session model |
| Gemini CLI | 50% of context window | Two-pass summarize-then-verify; keeps last 30% of history verbatim | Same session model |
| OpenHands | ~120 events OR agent-requested | LLM summary of middle; first 4 and last ~10 events verbatim; append-only event store on disk | Separate cheaper model |
| SWE-agent | Per-turn sliding window | **Observation masking only** — keeps last M=10 observations, replaces older with placeholders; no LLM call | No LLM needed |
| Aider | Never (manual) | `/drop`, `/clear`, `/tokens` — user-directed | N/A |
| Factory.ai Hermes | 50% (agent), 85% (gateway) | Anchored iterative: 4-phase structured update across 8 named sections | Separate auxiliary model |

### Academic literature

**["The Complexity Trap" (JetBrains, NeurIPS 2025 DL4Code Workshop, arXiv:2508.21433)](https://arxiv.org/abs/2508.21433)**
The most directly relevant finding: simple observation masking outperforms LLM summarization in 4 out of 5 coding-agent test settings. LLM summarization introduces **trajectory elongation** — compressing failure signals causes agents to retry things they already tried, running ~15% more turns. Observations dominate token consumption (~84% of turn tokens in SE agent trajectories). LLM summarization adds 5–7% extra API cost for the summary call itself.

**[MemGPT (Packer et al., 2023, arXiv:2310.08560)](https://arxiv.org/abs/2310.08560)**
OS-inspired virtual context: main context (FIFO history with a rolling recursive summary at position 0) + external archival storage (LanceDB, searchable via agent tool calls). The agent itself manages memory. Recursive summary means each eviction merges the old summary with the newly evicted batch.

**[TACO: Terminal Agent Context Compression (2025, arXiv:2604.19572)](https://arxiv.org/html/2604.19572v1)**
Maintains a global rule pool of compression rules evolved from failure analysis. Critical rule: **outputs containing error or failure signals are always kept verbatim** — never compressed. Compression rules have `keep patterns` (errors, success indicators) and `strip patterns` (progress bars, verbose listings).

**[Acon: Optimizing Context Compression for Long-Horizon Agents (2025, arXiv:2510.00615)](https://arxiv.org/html/2510.00615v1)**
Gradient-free guideline optimization: analyzes sessions where the agent succeeded with full context but failed with compressed context, then refines compression guidelines. Key insight: causal relations (why a decision was made), evolving states (what changed), and preconditions must survive compression.

**[HiAgent: Hierarchical Working Memory Management (ACL 2025, arXiv:2408.09559)](https://arxiv.org/abs/2408.09559)**
Subgoal-based summarization: when a subgoal completes, all action-observation pairs for it are summarized. Results: 2× success rate, 3.8 fewer steps, 35% shorter context vs. flat management.

**[Factory.ai structured summarization evaluation](https://factory.ai/news/evaluating-compression)**
Free-form summaries silently drop content. Named sections act as checklists — the model is forced to look for that type of information before moving on. Six quality dimensions: accuracy (file paths, error messages) > artifact trail (what was read/modified) > continuity (seamless resumption) > context awareness > completeness > instruction following. Factory scored 3.70 vs. Anthropic 3.44 vs. OpenAI 3.35.

### Key conclusions for OpenCLI

1. **Token-based trigger, not message count.** Message count is a proxy that misfires in both directions. Use `estimatedTokens` (already computed in the agent loop) vs. the model's actual context window.

2. **Structured summary, not free-form.** Named sections with mandatory content force completeness. Five sections cover coding sessions: Task, Progress, Decisions, Errors, State.

3. **Error signals must never be paraphrased.** Tool results containing `"Error:"` are extracted from the head and quoted verbatim inside the Errors section. This is the fix for trajectory elongation.

4. **Cheaper compaction model.** Using the same session model for summarization is expensive (one compaction on a long Opus session ≈ $0.40, per Claude Code data). Use the cheapest model per provider; the session API key already covers it.

5. **Observation masking is worth noting.** For a future auto-compact V2, pure observation masking (no LLM call) is competitive with summarization and avoids the elongation problem. The V1 structured-summary approach is more information-preserving for long sessions with complex decisions.

---

## A5a — What is (and is NOT) included

**What A5a implements:**
- User can call `/compact` at any time to summarize old messages
- `/context` shows current token usage and percentage of context window
- Core compaction algorithm: tail-keep (last 10 messages) + head-summarize + error-signal extraction
- Structured 5-section summary prompt (Task/Progress/Decisions/Errors/State)
- Cheap compaction model selection (haiku/flash-lite per provider)
- Unit tests for structural properties

**What A5a explicitly does NOT do:**
- No auto-compact hook. No timer or threshold trigger. Users decide when to compact.
- No token API integration. Keeps the `JSON.stringify.length / 4` estimate (known to be 2–3× inaccurate; documented as a known gap for A5b).
- No original prompt preservation logic. Summarizes everything in the head (A5b will keep first 2 messages verbatim).
- No compaction model failure handling beyond "propagate the error." The `/compact` command can fail and the user retries (A5b adds retry + fallback logic).
- No mid-task compaction risk (doesn't apply; manual invocation is always at a user choice point).
- No observability or metrics (A5b instruments this).

A5a ships a manual escape hatch. It is not yet a smart, automatic system. That comes in A5b after real-session validation.

---

## Algorithm (shared between A5a and A5b)

```
compactHistory(context, compactionClient):
  1. messages = context.getMessages()
  2. If messages.length < COMPACT_MIN_MESSAGES → return { messagesRemoved: 0 }
  3. tail = messages.slice(-KEEP_RECENT)
  4. head = messages.slice(0, -KEEP_RECENT)
  5. If head.length === 0 → return { messagesRemoved: 0 }
  6. errorResults = extractErrorResults(head)   ← function_result parts containing "Error:"
  7. summary = stream(compactionClient, head, SUMMARIZATION_PROMPT)
  8. summaryMessage = assemble(summary, errorResults)
  9. context.replaceHistory([summaryMessage, ...tail])
  10. return { messagesRemoved: head.length, summaryLength: summary.length }
```

### Step 6 — error signal extraction

Scan every `function_result` part in the head for lines beginning with `"Error:"`. These are produced by the executor when `result.error` is set:

```typescript
function extractErrorResults(messages: Message[]): string[] {
  const errors: string[] = [];
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "function_result" && part.result.includes("Error:")) {
        errors.push(`[${part.name}] ${part.result}`);
      }
    }
  }
  return errors;
}
```

### Step 8 — summary message assembly

```typescript
const errorBlock =
  errors.length > 0
    ? `\n\n### Verbatim error outputs preserved from compacted history\n\n` +
      errors.map((e) => "```\n" + e + "\n```").join("\n\n")
    : "";

const summaryMessage: Message = {
  role: "user",
  parts: [
    {
      type: "text",
      text: `[Session context compacted — earlier conversation summarized]\n\n${summary}${errorBlock}`,
    },
  ],
};
```

---

## Context window lookup (A5a + A5b shared)

Used by `/context` display (A5a) and auto-compact trigger (A5b):

```typescript
// Matched longest-prefix-first.
const MODEL_CONTEXT_WINDOWS: [prefix: string, tokens: number][] = [
  ["gemini-2.5",  1_048_576],
  ["gemini-2.0",  1_048_576],
  ["gemini-1.5",  1_048_576],
  ["claude-",       200_000],
  ["gpt-4o",        128_000],
  ["o1",            200_000],
  ["o3",            200_000],
  ["o4",            200_000],
];

const DEFAULT_CONTEXT_WINDOW = 100_000; // conservative fallback for unknown models

export function contextWindowFor(model: string): number {
  for (const [prefix, size] of MODEL_CONTEXT_WINDOWS) {
    if (model.startsWith(prefix)) return size;
  }
  return DEFAULT_CONTEXT_WINDOW;
}
```

In **A5a** (`/context` display): shows `estimatedTokens / contextWindow * 100%`.
In **A5b** (auto-compact): threshold will be `estimatedTokens >= 0.75 * contextWindowFor(model)` — defined in A5b spec.

---

## Structured summarization prompt

```
Summarize this coding session for context compaction.
Respond with exactly these five sections using these headers — do not add or rename sections:

## Task
The original user request and overall goal. One or two sentences.

## Progress
What has been completed. List every file created or modified with its exact path.

## Decisions
Key technical choices made during the session and the reason for each.

## Errors
Any error messages or test failures encountered. Quote them exactly — do not paraphrase.
If resolved, state the resolution. If unresolved, say so.

## State
Current state of work and the immediate next steps remaining.

Rules:
- Under 400 words total.
- Copy file paths, error messages, function names, and version numbers exactly.
- Do not narrate tool calls. Focus on outcomes and current state.
```

The five mandatory sections act as a checklist: the model must explicitly search for errors before writing "none," preventing silent omissions.

---

## Compaction client — `src/providers/factory.ts`

```typescript
// Cheapest capable model per provider, using the same API key as the session.
const COMPACTION_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  gemini:    "gemini-2.0-flash-lite",
  openai:    "gpt-4.1-mini",
};

export function createCompactionClient(sessionModel: string, apiKey: string): LLMClient {
  const provider = detectProvider(sessionModel);
  const model = COMPACTION_MODELS[provider] ?? sessionModel;
  return createClient(model, apiKey, { provider });
}
```

The compaction client is created by the CLI layer (which has the API key) and passed to the `Agent` constructor as an optional dependency. If absent, `compactHistory()` falls back to the main client.

---

## New file: `src/core/compact.ts`

### Constants

```typescript
const KEEP_RECENT = 10;
const COMPACT_MIN_MESSAGES = 4;
const COMPACT_THRESHOLD = 0.75;
```

### Interface

```typescript
export interface CompactResult {
  messagesRemoved: number;
  summaryLength: number;
}

/**
 * Replace old messages in `context` with a structured LLM-generated summary.
 * Keeps the most recent KEEP_RECENT messages verbatim.
 * Error signals from tool results are quoted verbatim in the summary.
 * Returns { messagesRemoved: 0 } if history is too short to compact.
 * Never throws — propagates LLM errors to the caller.
 */
export async function compactHistory(
  context: ContextManager,
  compactionClient: LLMClient,
): Promise<CompactResult>;

/** Look up the context window size for a model, with a conservative fallback. Used by /context (A5a) and auto-compact (A5b). */
export function contextWindowFor(model: string): number;
```

---

## Changes to `src/core/context.ts`

Two additions (getters), no behaviour changes to existing methods:

**Note on `replaceHistory()` vs `restoreMessages()`:** The design doc originally specified adding a new `replaceHistory()` method. The implementation pragmatically reuses the existing `restoreMessages()` method, which does exactly the same thing (direct history assignment without calling `prune()`). Both approaches are functionally equivalent; the existing method is preferred to avoid duplication.

```typescript
get messageCount(): number {
  return this.history.length;
}

get maxMessages(): number {
  return this.maxHistoryMessages;
}
```

Used by compaction:
```typescript
context.restoreMessages([summaryMessage, ...tail]);
```

---

## Changes to `src/core/agent.ts`

### Constructor

```typescript
constructor(
  private client: LLMClient,
  private tools: ToolRegistry,
  private skills: SkillRegistry,
  systemInstruction?: string,
  maxHistoryMessages?: number,
  private maxTurns: number = DEFAULT_MAX_TURNS,
  options?: {
    model?: string;
    onObservability?: ObservabilityHandler;
    snapshotManager?: SnapshotManager;
    compactionClient?: LLMClient;   // ← new
  },
) {
  this.compactionClient = options?.compactionClient ?? client;
  ...
}
```

### Manual compact and context stats (A5a)

```typescript
async compact(): Promise<CompactResult> {
  return compactHistory(this.context, this.compactionClient);
}

getContextStats(): { messageCount: number; estimatedTokens: number; contextWindow: number; maxHistoryMessages: number } {
  const messages = this.context.getMessages();
  return {
    messageCount: this.context.messageCount,
    estimatedTokens: Math.round(JSON.stringify(messages).length / 4),
    contextWindow: contextWindowFor(this.model),
    maxHistoryMessages: this.context.maxMessages,
  };
}
```

---

## Changes to `src/cli/index.ts`

Pass the compaction client when constructing the Agent:

```typescript
const compactionClient = createCompactionClient(model, apiKey);
const agent = new Agent(client, tools, skills, systemInstruction, historySize, maxTurns, {
  model,
  onObservability,
  snapshotManager,
  compactionClient,
});
```

---

## Changes to `src/cli/repl.ts`

### Add to `BUILTIN_COMMANDS`

```typescript
{ name: "compact", description: "summarize older conversation history to free context" },
{ name: "context", description: "show current token usage vs. context window" },
```

### `/compact` handler

```typescript
if (input === "/compact") {
  const stats = agent.getContextStats();
  if (stats.messageCount < 4) {
    printInfo("Nothing to compact — conversation is too short.");
    continue;
  }
  printInfo("Compacting conversation history…");
  try {
    const result = await agent.compact();
    if (result.messagesRemoved === 0) {
      printInfo("Nothing to compact — recent messages fill the full window.");
    } else {
      printInfo(
        `Compacted ${result.messagesRemoved} message(s) into a ${result.summaryLength}-char summary.`,
      );
    }
  } catch (err) {
    printError(`Compaction failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  continue;
}
```

### `/context` handler (A5a)

```typescript
if (input === "/context") {
  const { messageCount, estimatedTokens, contextWindow } = agent.getContextStats();
  const pct = Math.round((estimatedTokens / contextWindow) * 100);
  printInfo(`Est. tokens:  ~${estimatedTokens.toLocaleString()} / ${contextWindow.toLocaleString()}  (${pct}%)`);
  printInfo(`Messages:     ${messageCount}`);
  continue;
}
```

---

## Failure modes (A5a only)

| Failure | Behaviour |
|---|---|
| History too short (< 4 messages) | Returns `{ messagesRemoved: 0 }`; REPL prints "too short" |
| All messages fit in KEEP_RECENT window | Returns `{ messagesRemoved: 0 }`; REPL prints "fills the full window" |
| Compaction model API error | `compact()` propagates the error; REPL catches and prints via `printError()`; history untouched |
| Compaction model returns empty summary | Summary message is `[Session context compacted]\n\n` — visibly empty; REPL still prints stats |
| Model not in context window table | Falls back to 100K conservative default; `/context` shows the fallback |

---

## Test strategy (A5a)

### `src/core/compact.test.ts` (new)

| Test | What it proves |
|---|---|
| History < 4 messages → `messagesRemoved: 0`, history unchanged | Short-session guard |
| All messages in KEEP_RECENT window → `messagesRemoved: 0` | Full-window guard |
| 20 messages → summary message + last 10 kept verbatim | Core compaction |
| Summary message has `role: "user"` and `[Session context compacted]` prefix | Message format |
| `messagesRemoved` = total − KEEP_RECENT | Count accuracy |
| Mock client returns empty string → summary message has empty body | Empty summary |
| Head contains function_result with "Error:" → error block present in summary | Error signal preservation |
| Head contains function_result without "Error:" → no error block | Error detection specificity |
| `contextWindowFor("claude-opus-4-7")` → 200_000 | Lookup exact match |
| `contextWindowFor("gemini-2.5-whatever")` → 1_048_576 | Lookup prefix match |
| `contextWindowFor("unknown-model-xyz")` → 100_000 | Fallback |

Use a mock `LLMClient` that returns a fixed summary string. No real API calls.

### `src/core/context.test.ts` (extend)

| Test | What it proves |
|---|---|
| `replaceHistory([])` → `messageCount === 0` | Replace with empty |
| `replaceHistory(msgs)` → `messageCount === msgs.length` | Replace with content |
| `maxMessages` returns constructor value | Getter correct |
| `messageCount` tracks `addMessage` calls | Getter correct |

### `src/providers/factory.test.ts` (extend)

| Test | What it proves |
|---|---|
| `createCompactionClient("claude-opus-4-7", key)` returns client using haiku model | Provider mapping |
| `createCompactionClient("gemini-2.5-pro", key)` returns client using flash-lite | Provider mapping |
| `createCompactionClient("gpt-4o", key)` returns client using gpt-4.1-mini | Provider mapping |

---

## Compaction quality evaluation

### Why it is harder than unit testing

The unit tests in the previous section verify structural properties — sections present, error signals quoted, message count correct. They do not verify semantic fidelity: whether the summary preserved everything the agent will actually need. There is a gap between "the summary looks complete" and "the agent can finish the task after compaction."

Two failure modes are opposite in character and require different detection strategies:

- **Over-compression**: something important was dropped silently. The agent drifts, re-attempts things it already tried, or asks the user to repeat themselves. Only visible in downstream agent behaviour, not in the summary text itself.
- **Under-compression**: the summary is verbose, barely reduces token count, and the auto-compact trigger fires again immediately. Detectable from `summaryLength` and the next turn's `estimatedTokens`.

### The sequencing problem

To evaluate compaction quality you need sessions long enough to trigger compaction. Those do not exist yet. Building a compaction eval harness before we have real data is premature — we would be optimizing against synthetic sessions that may not represent real usage patterns.

### Proposed evaluation path

**Phase 1 — A5a (now):** Structural unit tests only. Covers format, error-signal extraction, and context window lookup. This is what the test strategy above specifies.

**Phase 2 — A5a post-ship (after real sessions):** Manual inspection. Collect a handful of real session logs where users called `/compact` manually. Read each summary against the original head messages. This surfaces the first real failures cheaply and guides prompt tuning without requiring infrastructure. Run for 1–2 weeks to gather enough data.

**Phase 3 — A5b (medium-term, after Phase 2 data):** Design review of A5b with Phase 2 findings. Then implement auto-compact with opt-in gate. D1 integration: extend the eval harness with one or two scenarios that produce enough history to cross the 75% token threshold (e.g., 15-turn multi-file refactor), then compare solve rate before and after auto-compact is enabled. This is the most honest signal: if the agent still completes the task, the summary preserved enough.

**Phase 4 — Structured eval (if Phase 3 reveals problems):** If auto-compact causes regressions, add structured recall measurement. Extract "ground truth facts" from the head messages before compaction — every file path, every error message, every explicit decision. Check what fraction appear in the summary. This is more objective than LLM-as-judge because it tests specific claims rather than fluency.

---

## Deferred to A5b (auto-compact phase)

- **Auto-compact trigger** — only after A5a ships and Phase 2 real-session inspection completes
- **Token API integration** — replace `JSON.stringify.length / 4` with provider `countTokens` APIs; critical for accuracy
- **Original prompt preservation** — keep first 2 messages verbatim to prevent constraint loss
- **Compaction model failure handling** — retry logic + fallback to main client
- **Turn-boundary detection** — trigger only after agent completes a full turn (no mid-task compaction)
- **Threshold warnings** — print hint at 60%, stronger hint at 75%
- **Config gate** — `autoCompact: false` default; flip to `true` after Phase 3 validation
- **Observability** — metrics for compaction frequency, token freed, costs

## Deferred to future milestones

### Observation masking (post-A5b evaluation)

The JetBrains "Complexity Trap" paper (arXiv:2508.21433) shows observation masking matches or beats LLM summarization in most coding-agent benchmarks at zero additional API cost. After A5b ships and we have real data, consider masking as an alternative: keep the last M=10 tool-result messages verbatim, replace older ones with a one-line placeholder. This avoids trajectory elongation entirely and has no compaction model cost.

### Persistent token bar in REPL footer

Requires per-input ANSI cursor management. Squarely A6 scope. `/context` covers the information need for now.

### `--compaction-model` / `compactionModel` config field

The `COMPACTION_MODELS` table hard-codes cheapest-per-provider. A config field `compactionModel` (in `~/.opencli/config.json`) and a `--compaction-model` CLI flag allow users to override. Deferred — add when someone needs it.

---

## References

| Source | What it contributed |
|---|---|
| ["The Complexity Trap" (JetBrains, NeurIPS 2025 DL4Code, arXiv:2508.21433)](https://arxiv.org/abs/2508.21433) | Observation masking vs. LLM summarization benchmark; trajectory elongation effect; 84% of tokens are observations |
| [MemGPT / Letta (Packer et al., 2023, arXiv:2310.08560)](https://arxiv.org/abs/2310.08560) | Recursive summarization; two-tier memory hierarchy; agent-managed archival storage |
| [TACO (2025, arXiv:2604.19572)](https://arxiv.org/html/2604.19572v1) | Error signals must be kept verbatim; rule-based compression; global rule pool with confidence scoring |
| [Acon (2025, arXiv:2510.00615)](https://arxiv.org/html/2510.00615v1) | Causal relations, evolving states, preconditions as critical content; gradient-free guideline optimization |
| [HiAgent (ACL 2025, arXiv:2408.09559)](https://arxiv.org/abs/2408.09559) | Subgoal-aligned summarization; 2× success rate, 35% shorter context |
| [Factory.ai structured summarization evaluation](https://factory.ai/news/evaluating-compression) | Named sections vs. free-form; 3.70 vs. 3.44 quality score; 6 quality dimensions |
| [Claude Code compaction documentation](https://platform.claude.com/docs/en/build-with-claude/compaction) | `compact_20260112` API strategy; CLAUDE.md re-injection; microcompact; $0.40 per compaction cost data |
| [Gemini CLI context management (DeepWiki)](https://deepwiki.com/google-gemini/gemini-cli/4.12-chat-compression-and-context-management) | 50% threshold; two-pass verify; 30% tail preservation; `findCompressSplitPoint()` |
| [OpenHands condenser architecture](https://docs.openhands.dev/sdk/arch/condenser) | Event store; nine pluggable condenser strategies; cheaper dedicated model for summarization |
| [SWE-agent (Princeton NLP)](https://swe-agent.com/) | M=10 observation masking; 52% cost reduction; 2.6% solve-rate improvement |

---

## File change summary — A5a only

| Action | File |
|---|---|
| Create | `src/core/compact.ts` — `compactHistory()`, `contextWindowFor()`, structured prompt, error extraction |
| Create | `src/core/compact.test.ts` — unit tests for compaction algorithm and error detection |
| Modify | `src/core/context.ts` — add `replaceHistory()`, `messageCount` getter, `maxMessages` getter |
| Modify | `src/core/context.test.ts` — extend with new getter/method tests |
| Modify | `src/core/agent.ts` — add `compactionClient` constructor option, add `compact()` and `getContextStats()` methods |
| Modify | `src/providers/factory.ts` — add `COMPACTION_MODELS` map, add `createCompactionClient()` function |
| Modify | `src/cli/index.ts` — create and pass `compactionClient` to Agent constructor |
| Modify | `src/cli/repl.ts` — add `/compact` handler, add `/context` handler |

**A5b (auto-compact, deferred) will additionally modify:**
- `src/core/agent.ts` — add `compact` event type, add auto-compact hook in main loop
- `src/core/compact.ts` — add token API client integration, add `isAutoCompactNeeded()` function
- `src/cli/repl.ts` — add threshold warnings, handle `compact` events
- Config system — add `autoCompact: boolean` field (default false)
