# Design: A5 — /compact + /context

_Status: Ready for implementation. Tracking issue: [#26](https://github.com/zjshen14/opencli/issues/26). Phase: [Roadmap A5](../roadmap.md)._

---

## Problem and goal

`ContextManager.prune()` hard-drops old messages with `slice(-maxHistoryMessages)`. On long sessions the agent loses its original task description, early decisions, and file paths it already visited — causing drift and repeated work. Users have no way to see how full the context window is or to do anything about it before the drop happens silently.

**Goal:** give users a `/compact` command that replaces old messages with an LLM-generated structured summary, and a `/context` command that reports current token usage. Also add auto-compact that fires at 75% of the model's actual context window.

---

## Scope

| Item | V1 (this milestone) |
|---|---|
| `/compact` — manual structured LLM summarization | ✓ |
| `/context` — print estimated tokens vs. context window | ✓ |
| Auto-compact at 75% token threshold | ✓ |
| `createCompactionClient()` — cheapest model per provider | ✓ |
| Persistent token bar in REPL footer | Deferred to A6 (UX rendering milestone) |
| `--compaction-model` CLI flag | Deferred — config field `compactionModel` is the extension point |

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

## Algorithm

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

## Context window lookup

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

Auto-compact fires when:

```typescript
estimatedTokens >= COMPACT_THRESHOLD * contextWindowFor(this.model)
// COMPACT_THRESHOLD = 0.75
```

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

/** Returns true when the agent loop should trigger auto-compact. */
export function isAutoCompactNeeded(estimatedTokens: number, model: string): boolean;

/** Look up the context window size for a model, with a conservative fallback. */
export function contextWindowFor(model: string): number;
```

---

## Changes to `src/core/context.ts`

Three additions, no behaviour changes to existing methods:

```typescript
// Used by compactHistory() to install the compacted state.
// Does NOT call prune() — the caller has already sized the history correctly.
replaceHistory(messages: Message[]): void {
  this.history = messages;
}

get messageCount(): number {
  return this.history.length;
}

get maxMessages(): number {
  return this.maxHistoryMessages;
}
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

### New `AgentEvent` variant

```typescript
| { type: "compact"; messagesRemoved: number; summaryLength: number }
```

### Auto-compact hook in the main loop

After `estimatedTokens` is computed (already present), before the LLM call:

```typescript
if (isAutoCompactNeeded(estimatedTokens, this.model)) {
  const result = await compactHistory(this.context, this.compactionClient);
  if (result.messagesRemoved > 0) {
    yield { type: "compact", messagesRemoved: result.messagesRemoved, summaryLength: result.summaryLength };
  }
}
```

### Manual compact and context stats

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

### `/context` handler

```typescript
if (input === "/context") {
  const { messageCount, estimatedTokens, contextWindow } = agent.getContextStats();
  const pct = Math.round((estimatedTokens / contextWindow) * 100);
  printInfo(`Est. tokens:  ~${estimatedTokens.toLocaleString()} / ${contextWindow.toLocaleString()}  (${pct}%)`);
  printInfo(`Messages:     ${messageCount}`);
  continue;
}
```

### Handle auto-compact events in the render loop

```typescript
} else if (event.type === "compact") {
  printInfo(
    `[auto-compacted: ${event.messagesRemoved} messages replaced by structured summary]`,
  );
}
```

---

## Failure modes

| Failure | Behaviour |
|---|---|
| History too short (< 4 messages) | Returns `{ messagesRemoved: 0 }`; REPL prints "too short" |
| All messages fit in KEEP_RECENT window | Returns `{ messagesRemoved: 0 }`; REPL prints "fills the full window" |
| Compaction model API error | `compact()` propagates the error; REPL catches and prints via `printError()`; history untouched |
| Compaction model returns empty summary | Summary message is `[Session context compacted]\n\n` — visibly empty; REPL still prints stats |
| Model not in context window table | Falls back to 100K conservative default; auto-compact fires later than optimal but not incorrectly |
| Auto-compact fires mid-stream | The check runs before the LLM call, never during a stream; history is stable at the time of compaction |

---

## Test strategy

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
| `isAutoCompactNeeded(150_001, "claude-sonnet-4-6")` → true (75% of 200K) | Threshold math |
| `isAutoCompactNeeded(149_999, "claude-sonnet-4-6")` → false | Threshold boundary |
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

**Phase 1 — V1 (now):** Structural unit tests only. Covers format, error-signal extraction, and threshold math. This is what the test strategy above specifies.

**Phase 2 — post-V1 (after real sessions):** Manual inspection. Collect a handful of real session logs that were auto-compacted. Read the summary against the original head messages. This surfaces the first real failures cheaply and guides prompt tuning without requiring infrastructure.

**Phase 3 — D1 integration (medium-term):** The D1 eval harness already runs full agent sessions against known scenarios. Extend it with one or two scenarios that produce enough history to cross the 75% token threshold — then compare solve rate before and after compaction is enabled. This is the most honest signal: if the agent still completes the task, the summary preserved enough. JetBrains and OpenHands both use this approach (arXiv:2508.21433; OpenHands SWE-bench results).

**Phase 4 — fact recall scoring (if problems emerge):** If Phase 3 reveals quality regressions, add structured recall measurement. Approach: before compaction, extract "ground truth facts" from the head messages — every file path, every error message, every explicit decision. After compaction, check what fraction appear in the summary text. This is more objective than LLM-as-judge because it tests specific claims rather than fluency. Factory.ai's 6-dimension LLM-as-judge evaluation is an alternative if recall scoring proves too brittle.

### What to instrument now to enable Phase 3

The D1 harness runs `node dist/index.js run` as a subprocess and checks output. To measure compaction impact:

1. Add a long scenario to the D1 scenario set — e.g., a multi-file refactor that requires 15+ tool calls, generating enough history to approach the context threshold.
2. The agent already emits `compact` events; the CLI already prints `[auto-compacted: ...]`. The D1 runner can check for this string in the output to confirm compaction fired.
3. Run the same scenario with `maxHistoryMessages=1000` (effectively disabling compaction) and with the default threshold. Compare solve rates across N runs.

This does not need to happen in A5. Flagging it here so the D1 harness extension is a known follow-on task, not a surprise.

---

## Deferred

### Auto-compact V2: observation masking

The JetBrains "Complexity Trap" paper (arXiv:2508.21433) shows observation masking matches or beats LLM summarization in most coding-agent benchmarks at zero additional API cost. A future iteration could try masking as the primary strategy: keep the last M=10 tool-result messages verbatim, replace older ones with a one-line placeholder. This avoids trajectory elongation entirely and has no compaction model cost. Needs evaluation against real OpenCLI sessions before adopting.

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

## File change summary

| Action | File |
|---|---|
| Create | `src/core/compact.ts` |
| Create | `src/core/compact.test.ts` |
| Modify | `src/core/context.ts` — `replaceHistory()`, `messageCount` getter, `maxMessages` getter |
| Modify | `src/core/context.test.ts` — new method tests |
| Modify | `src/core/agent.ts` — `compactionClient` constructor option, `compact` event, auto-compact hook, `compact()`, `getContextStats()` |
| Modify | `src/providers/factory.ts` — `COMPACTION_MODELS`, `createCompactionClient()` |
| Modify | `src/cli/index.ts` — create and pass `compactionClient` to Agent |
| Modify | `src/cli/repl.ts` — `/compact`, `/context` handlers; handle `compact` event |
