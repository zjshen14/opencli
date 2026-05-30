# Design: A5 — /compact + /context

_Status: A5a Implemented — merged in 4aba15e (2026-05-17), closes [#112](https://github.com/zjshen14/opencli/issues/112). A5b Ready for implementation — Phase 2 data collected from the card_trade session, deferred risks resolved below; tracking [#113](https://github.com/zjshen14/opencli/issues/113). Phase: [Roadmap A5](../roadmap.md)._

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

### **A5b — Auto-compact with safety gates (ready for implementation)**
- Auto-compact fires at **turn boundary** when `estimatedTokens / contextWindowFor(model) >= 0.75`
- Token estimation stays on `JSON.stringify.length / 4` — Phase 2 data shows it's accurate enough as a *trigger* (off by a constant factor; threshold tuning absorbs it). Provider-API token counting deferred to a future change once a concrete reason to be exact appears.
- Config gate: `autoCompact: true` default once landed (validated by A5a + Phase 2). `autoCompact: false` opts out.
- Threshold warning at 60%; auto-compact at 75% (one warning per session)
- Original prompt preservation: anchor logic from PR #154 already keeps the first user message; A5b makes it part of the summary path rather than the prune path
- Compaction failure handling: catch, surface via observability + stderr warning, continue with un-compacted history (fail-open)
- Replay test using the card_trade session as a fixture
- ~5 files, ~2 days to implement

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
| Auto-compact at turn boundary, 75% threshold | ✓ Spec'd below |
| Token estimation: keep `JSON.stringify.length / 4` (good enough for trigger) | ✓ Spec'd below |
| Config gate `autoCompact: true` default | ✓ Spec'd below |
| Original prompt preservation (anchor in summary message) | ✓ Spec'd below — composes with PR #154 prune anchor |
| Compaction failure handling — fail-open with observability event | ✓ Spec'd below |
| Threshold warning at 60% (once per session) | ✓ Spec'd below |
| Replay integration test using card_trade session | ✓ Spec'd below |
| Provider token APIs | Out of scope — defer until a real reason emerges |

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

## A5b — Auto-compact design (resolved against Phase 2 data)

### Phase 2 findings

The card_trade session (`2026-05-17T22-00-06-184`) ran across two real coding sessions and exposed the actual shape of context growth:

| Metric | Value | What it tells us |
|---|---|---|
| Total events in JSONL | 662 | Real sessions exceed the default `historySize: 50` by an order of magnitude |
| User turns | 42 | Manual `/compact` would require 21 invocations to keep the head visible — unrealistic |
| `tool_call` + `tool_result` pairs | 290 + 289 | Tool calls dominate context, exactly as the JetBrains paper predicted (~84% of tokens) |
| Estimated tokens (JSON/4) | ~402k | Under Gemini's raw 1M window (40%) but well over a sensibly-capped effective window — motivates the 256k cap in §2 |
| Tool results containing `Error:` | 23 | Error signals are real and frequent — the verbatim-preservation rule from A5a matters |
| First prune (50-message threshold) | event #92 | About 14% through; from there on the head was being dropped every turn |
| `JSON.stringify.length / 4` vs. real token count | within ~2× for Gemini; doesn't matter for trigger | A constant-factor error absorbs into the threshold. Save the provider-API round-trip cost. |

The session confirms the A5 thesis: **the user couldn't reasonably know when to `/compact`**, and prune was silently dropping the original task message every turn from event #92 onward. PR #154 (prune anchor) is keeping the *original task* visible — but not the 200+ messages of work-in-progress decisions, file paths, and intermediate state in between.

### Design decisions

#### 1. Trigger — *only* at turn boundary

The check runs **at the top of `Agent.run()`**, immediately after the new user message is appended to context and *before* the streaming loop:

```ts
async *run(userInput: string, mode: AgentRunMode = "react"): AsyncGenerator<AgentEvent> {
  this.context.addMessage({ role: "user", parts: [{ type: "text", text: userInput }] });

  // A5b: auto-compact at turn boundary, never mid-stream.
  await this.maybeAutoCompact();   // <-- new

  // ... existing while-loop ...
}
```

Why this specific position: by the time `addMessage` returns, the user has sent a complete prompt and the LLM hasn't seen it yet. No tool calls are in flight. No partial assistant response is buffered. Auto-compact replaces the head, then the loop begins as if resuming a fresh agent with a summary. This is the placement that makes trajectory elongation impossible — the LLM cannot retry an action it never saw, because everything before the summary point is now compressed into one user message.

Explicitly forbidden positions: between `client.stream()` arrival and `executeCalls()`; between `executeCalls()` and the next `client.stream()`; inside any compactionClient stream. None of these are turn boundaries.

#### 2. Threshold — 75% of an effective window, with a 60% soft warning

The trigger compares estimated tokens to `min(contextWindowFor(model), COMPACTION_TARGET_TOKENS)` where `COMPACTION_TARGET_TOKENS = 256_000`:

```ts
const COMPACTION_TARGET_TOKENS = 256_000;

const tokens = estimateTokens(context.getMessages(), systemInstruction);
const window = Math.min(contextWindowFor(this.model), COMPACTION_TARGET_TOKENS);
const ratio = tokens / window;
```

- `ratio >= 0.75` → auto-compact this turn (call `compactHistory()`)
- `0.60 <= ratio < 0.75` → emit one notice per session: `context at 60% — auto-compact will trigger at 75%`
- `ratio < 0.60` → no action

**Why cap the window at 256K** when Gemini supports 1M:

| Model | Raw window | Effective window | Trigger | Behavior on card_trade |
|---|---|---|---|---|
| Gemini 2.5/3.x (1M) | 1,000,000 | 256,000 | 192,000 tokens | Compacts at turn ~20, 32 — 2 compactions total |
| Anthropic Sonnet (200K) | 200,000 | 200,000 | 150,000 tokens | Compacts earlier; same shape |
| OpenAI gpt-4o (128K) | 128,000 | 128,000 | 96,000 tokens | Compacts more aggressively |
| Unknown (100K fallback) | 100,000 | 100,000 | 75,000 tokens | Most aggressive |

Without the cap, the 1M Gemini window puts the trigger at 750k — the card_trade session (which maxed at ~402k estimated tokens) would never compact, defeating the purpose. The 256k cap is also defensible on cost-and-latency grounds: very long contexts increase per-turn latency and dollars, and our cheap compaction summary is much faster to produce at 256k than at 750k. Users who genuinely want the full Gemini window can set `autoCompact: false`.

The "warned at 60%" state lives in an `Agent` instance field (`warnedAt60: boolean`). It resets in two places:
1. `clearHistory()` — session reset
2. Successful `compactHistory()` — after a compaction, ratio drops well below 60%; re-arming the warning lets the user see the *next* climb back toward the threshold (relevant for very long sessions that compact more than once).

#### 3. Token estimation — keep `JSON.stringify / 4`

The Phase 2 measurement confirms the estimator is off by a constant factor (~2× for Gemini text content, much closer for tool results which are mostly bytes). For a *threshold trigger*, constant-factor error is fine — it just shifts when the trigger fires. Provider-API token counting would add an async round-trip on every turn for no behavior gain.

If the estimator turns out to be wildly different on a real provider (e.g., Anthropic Sonnet streaming with thoughtSignature inflation), we can replace the estimator inside `Agent.getContextStats()` without touching the trigger logic. The contract is `(messages, systemInstruction) → estimatedTokens`, called once per turn.

#### 4. Original prompt preservation — done via summary message, not prune

`compactHistory()` already keeps the last `KEEP_RECENT` messages verbatim and synthesizes one summary message at position 0. The summary message body must lead with a verbatim quotation of the original first user message (the task statement) so it never gets paraphrased:

```ts
const originalTask = context.history[0]?.parts.find(p => p.type === "text")?.text ?? "";
const summaryBody = `[Session context compacted]

**Original task** (verbatim):
> ${originalTask.split("\n").join("\n> ")}

${structuredSummary}${errorBlock}`;
```

After A5b lands, the prune anchor logic in `prune()` (from PR #154) becomes a safety net rather than the primary mechanism — useful for sessions that never compact (short ones, `autoCompact: false`).

#### 5. Compaction failure — fail-open, surface via observability + AgentEvent stream

`compactHistory()` calls a network LLM and can fail (rate limit, network glitch, malformed response). A5b must not block the user's turn on a compaction failure.

Two implementation rules:

1. **The signal goes through the existing event stream**, not `process.stderr`. The agent loop already yields `error` events for snapshot warnings (`agent.ts:249-252`) and the REPL renderer handles them — direct `stderr.write` from inside `core/` would couple the library to a console and could collide with `MarkdownStreamRenderer`'s paragraph buffering. To keep notices distinct from real errors, **add a new `AgentEvent` variant**: `{ type: "notice"; message: string }`.
2. **The trigger uses Agent's actual shape**: a discrete field `private autoCompact: boolean`, not `this.config.autoCompact` (the Agent stores fields directly, not a config object — see `agent.ts:50-56`). The token estimate **must include `systemInstruction`** so the trigger matches what the next `client.stream()` actually sends (the existing `getContextStats()` only counts messages; A5b will tighten it or add a separate `estimateTurnTokens(systemInstruction)` method).

Concrete shape:

```ts
private async maybeAutoCompact(systemInstruction: string): Promise<AgentEvent[]> {
  if (!this.autoCompact) return [];

  const messages = this.context.getMessages();
  const tokens = Math.round(
    (JSON.stringify(messages).length + systemInstruction.length) / 4,
  );
  const effectiveWindow = Math.min(contextWindowFor(this.model), COMPACTION_TARGET_TOKENS);
  const ratio = tokens / effectiveWindow;

  if (ratio < 0.60) return [];

  if (ratio < 0.75) {
    if (this.warnedAt60) return [];
    this.warnedAt60 = true;
    this.obs?.({ type: "compact_threshold_warned", ratio });
    return [
      {
        type: "notice",
        message: `context at ${Math.round(ratio * 100)}% — auto-compact will trigger at 75%`,
      },
    ];
  }

  // ratio ≥ 0.75 — auto-compact this turn
  this.obs?.({ type: "compact_started", trigger: "auto", ratio });
  try {
    const result = await compactHistory(this.context, this.compactionClient);
    this.warnedAt60 = false; // re-arm: ratio drops well below 60% after compaction
    this.obs?.({
      type: "compact_completed",
      trigger: "auto",
      messagesRemoved: result.messagesRemoved,
      summaryLength: result.summaryLength,
    });
    return [
      {
        type: "notice",
        message: `auto-compacted ${result.messagesRemoved} older messages into a ${result.summaryLength}-char summary`,
      },
    ];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    this.obs?.({ type: "compact_failed", trigger: "auto", error: message });
    return [
      {
        type: "notice",
        message: `auto-compact failed: ${message} — continuing with full history`,
      },
    ];
  }
}
```

And the caller in `run()`:

```ts
async *run(userInput: string, mode: AgentRunMode = "react"): AsyncGenerator<AgentEvent> {
  this.context.addMessage({ role: "user", parts: [{ type: "text", text: userInput }] });

  const systemInstruction = mode === "plan" ? planSystem : reactSystem;
  for (const notice of await this.maybeAutoCompact(systemInstruction)) {
    yield notice;
  }

  // ... existing while-loop ...
}
```

Three reasons fail-open is the right posture:
1. The user has already typed their next prompt; blocking them on a compaction infra failure is hostile.
2. The pre-existing prune logic still bounds message count (with the PR #154 anchor preserving the original task), so context won't explode.
3. If failures are persistent, the observability events and the `notice` event make it visible — the user can choose to set `autoCompact: false`.

#### 6. Interaction with `prune()`

Compaction and `ContextManager.prune()` (default `maxHistoryMessages = 50`) run on different axes — *tokens* vs. *messages* — and they must coexist deterministically:

| Rule | What it does | When it fires |
|---|---|---|
| `prune()` | Drops messages from the head when count > `maxHistoryMessages`, keeping the PR #154 first-user-text anchor | Every `addMessage()` call |
| `compactHistory()` | Replaces the head with one structured summary message, keeping `KEEP_RECENT` messages verbatim | Top of `Agent.run()` when token ratio ≥ 0.75 (auto) or `/compact` (manual) |

Concrete invariants:

- **After a compaction**, history is `[summary, ...tail]` = 1 + `KEEP_RECENT` (10) = **11 messages**. This is well under `maxHistoryMessages = 50`, so prune is a no-op immediately after.
- **Between compactions**, messages accumulate through normal tool-call / tool-result turns. Once count crosses 50, prune fires and drops the oldest messages. **The summary message at position 0 is preserved** because the existing anchor logic preserves *the first user-role text message*, and the summary is exactly that shape (role: "user", parts: [{ type: "text" }]).
- **Recursive summarization** (a compaction whose head includes a previous summary) is handled by the structured prompt: it explicitly instructs the model to copy the prior "Original task" quotation block verbatim. The original first user message survives across an unbounded number of nested compactions by string equality, not by paraphrase.

This means the two mechanisms never fight: prune cannot drop a fresh summary (anchor protection), and compaction cannot lose the original task (verbatim quotation invariant). Compaction is the "real" mechanism; prune is the safety net that handles sessions that never compact (short ones, `autoCompact: false`, or model windows so large that the token threshold is never crossed).

#### 7. Config flag

Add to `~/.opencli/config.json` (`src/state/config.ts`):

```ts
export interface Config {
  // ...existing...
  /** Auto-compact context at 75% of model window. Default: true. */
  autoCompact?: boolean;
}
```

Default is **`true` once A5b lands**. Validated by the Phase 2 data — the card_trade session would have compacted at most 2-3 times across 42 turns, well within the cost envelope, and the user would not have lost mid-session decisions.

Opt-out: `opencli config --auto-compact false` (or hand-edit JSON).

#### 8. Observability events

Three new entries in `ObservabilityEvent`:

```ts
| { type: "compact_threshold_warned"; ratio: number }
| { type: "compact_started"; trigger: "auto" | "manual"; ratio?: number }
| { type: "compact_completed"; trigger: "auto" | "manual"; messagesRemoved: number; summaryLength: number }
| { type: "compact_failed"; trigger: "auto" | "manual"; error: string }
```

The existing `/compact` command should emit `compact_started` / `compact_completed` with `trigger: "manual"` once these types land — gives us a single observability surface for both code paths.

### Implementation outline (file list)

| Action | File | Purpose |
|---|---|---|
| Modify | `src/core/agent.ts` | Add `private autoCompact: boolean` field (constructor option `autoCompact?: boolean`, default true). Add `private warnedAt60: boolean`. Add `maybeAutoCompact(systemInstruction): Promise<AgentEvent[]>`. Call it at the top of `run()` and yield the returned notices. Reset `warnedAt60` in `clearHistory()` and on successful compaction. |
| Modify | `src/core/agent.ts` | Add `{ type: "notice"; message: string }` to the `AgentEvent` union so notices have a distinct shape from `error`. |
| Modify | `src/core/compact.ts` | Export `COMPACTION_TARGET_TOKENS = 256_000`. Prepend verbatim original-task quotation to the summary message body. Update the structured prompt to instruct the model to copy any prior "Original task" quotation verbatim (for nested compactions). |
| Modify | `src/core/observability.ts` | Add the four new event types: `compact_threshold_warned`, `compact_started`, `compact_completed`, `compact_failed`. |
| Modify | `src/state/config.ts` | Add `autoCompact?: boolean` field. Default resolution `autoCompact !== false`. |
| Modify | `src/cli/index.ts` | Pass `config.autoCompact` through to the `Agent` constructor. |
| Modify | `src/cli/renderer.ts` / `runner.ts` | Render `notice` events as a dim one-line `i message`. Keep them out of the markdown stream (write through `printInfo` or equivalent). |
| Modify | `src/core/compact.test.ts` | Add tests for: trigger at exact 75% of effective window; no trigger below 60%; warning at 60% emits notice; one warning per session; warning re-arms after successful compaction; fail-open on compactionClient error yields a notice; original task survives the summary. |
| Create | `src/core/compact.replay.test.ts` | Replay test using the card_trade session JSONL as a fixture (see §Test strategy below). |
| Modify | `src/cli/repl.ts` | Emit `compact_started` / `compact_completed` from the existing `/compact` handler with `trigger: "manual"`. |

### Test strategy

**Unit tests** (`compact.test.ts`):
- Auto-compact fires at `ratio >= 0.75` and not at `0.74999`
- Trigger correctly uses `min(contextWindow, COMPACTION_TARGET_TOKENS)` — a Gemini session at 200k tokens triggers (200k / 256k = 78%), not just at 750k
- No fire when `autoCompact: false` regardless of ratio
- Warning fires exactly once across consecutive turns above 60%
- Warning re-arms after a successful compaction (next climb back above 60% fires again)
- Warning resets on `clearHistory()`
- Compaction failure surfaces `compact_failed` and the turn proceeds (history unchanged)
- Summary message body begins with the verbatim original first user message
- After two consecutive compactions, the original task still appears verbatim at the head of the most recent summary (nested-compaction invariant)
- Notices are yielded through the `AgentEvent` stream, not written to `process.stderr`

**Replay test** (new `compact.replay.test.ts`):

The test must be parameterized so the trigger actually fires on the fixture; otherwise it passes trivially with zero compactions.

- Load the card_trade session JSONL (~662 events, ~402k tokens at end) as a fixture
- Construct an `Agent` with:
  - A mock `LLMClient` that returns minimal text (no real LLM cost during the replay)
  - A mock `compactionClient` whose `stream()` yields a deterministic summary string
  - The `Agent` configured with `model: "claude-sonnet-4-6"` (200k window) so trigger fires at ~150k tokens — within the session's range
- Walk the JSONL: for each `user` entry, call `agent.run(userText)` and drain the generator
- Collect every yielded `AgentEvent`, partitioning by type
- Assertions:
  - **Lower bound:** at least one `compact_completed` observability event was emitted (≥ 1 auto-compaction actually happened — proves the trigger fired against real data)
  - **Upper bound:** no more than 5 `compact_completed` events across the whole replay (proves runaway triggering didn't happen; based on the math in §2, expected value is 2-3 for the Claude-200k configuration)
  - **No-mid-task invariant:** every `compact_completed` event appears in the event stream *before* any `tool_call` event for the same user turn
  - **Original task verbatim:** after the final user turn, the summary message at position 0 in `context.getMessages()` contains the original first user message text as a verbatim substring
  - **Notice events emitted:** at least one `notice` event with `auto-compact` in the message (the user-visible signal)

The replay test is what specifically validates the design against the data the design was tuned for. Parameterizing the model is the trick that makes the test exercise the trigger instead of falling silently below it.

### Acceptance criteria

- `agent.run()` with `autoCompact: true` (default) calls `compactHistory()` exactly when `tokens / min(contextWindow, 256_000)` first crosses 0.75, before the first LLM call of that turn
- `agent.run()` with `autoCompact: false` never auto-compacts (manual `/compact` still works)
- 60% notice is yielded through the `AgentEvent` stream (not written to `stderr` from `core/`) exactly once per session, then re-arms after a successful compaction
- Compaction failure does not throw, does not block the turn, emits `compact_failed` observability, and yields a user-visible `notice`
- Replay test against the card_trade session: **≥ 1** and **≤ 5** auto-compactions across the full 42-turn session, with Claude-200k as the configured model in the fixture
- Summary message body always contains the verbatim text of the original first user message — including after a nested compaction (a compaction whose head contained a previous summary)
- The estimated-tokens computation in the trigger includes both messages and the system instruction (matching the actual `client.stream()` payload)
- `npm run typecheck && npm run lint && npm run format:check && npm test` pass

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
