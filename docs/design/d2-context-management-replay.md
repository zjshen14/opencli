# Design: D2 — Context-management replay (session-tape contract eval)

_Status: Ready for implementation. Phase: [Roadmap D2](../roadmap.md#phase-d--evaluation). Sibling of [D1](./d1-eval-harness.md)._

---

## Goal

Validate the **agent loop's context-management contract** — A5b auto-compact triggers at the expected ratios, the original-task prune anchor survives nested compactions, the parallel-batching reminder fires on the right turns, safety guards do not misfire — against **real recorded session shapes**, not toy fixtures.

The shipped unit tests cover the trigger math and the prune mechanic in isolation. They do not cover emergent behavior across a 660-line trajectory with realistic tool-output sizes. This eval fills that gap.

`npm run test:replay` is the entry point. It runs fully **offline** (no API calls). It is intentionally separate from `npm run eval` (D1, real API) and from `npm test` (which it joins as a CI gate, since cost is zero).

---

## Why this is D2 and not D1

| | D1 (matrix eval) | D2 (session replay) |
|---|---|---|
| Source of truth | YAML scenarios, hand-written | Real session JSONL tapes |
| LLM behavior | Real provider call (Gemini/Anthropic/OpenAI) | Mocked from recorded assistant output |
| Asserts on | Final file state + tsc gate | Observability event stream from `src/core/observability.ts` |
| Catches | "Does Gemini still pass scenario X?" | "Does auto-compact still fire at 75% on this real shape?" |
| Cost per run | $1–5 | $0 |
| Trigger | `workflow_dispatch` only | Every PR (folded into `npm test`) |

D1 catches **regressions visible to the user** (the agent failed to solve a task). D2 catches **regressions invisible to the user until they bite** (auto-compact silently stopped firing, prune anchor was dropped by a context-pruning refactor, the parallel-batching reminder is no longer being appended). Both miles of evaluation are needed; they are complementary.

---

## What we assert

Every assertion is on the `ObservabilityEvent` stream emitted by [`src/core/agent.ts`](../../src/core/agent.ts) via the handler injected at construction time. We are not asserting on file state — the test is about the agent loop's **internal contract**, not its external effects.

### A5b auto-compact contract

For a tape with sufficient token volume:

| Event | Assertion |
|---|---|
| `compact_threshold_warned` | Fires exactly once, at the first turn where `estimatedTokens / contextWindow >= 0.60`. Subsequent turns do not re-emit. |
| `compact_started` (trigger: "auto") | Fires at the first turn boundary where `estimatedTokens / contextWindow >= 0.75`. |
| `compact_completed` | Follows every `compact_started` (no orphaned `compact_started`). `messagesRemoved > 0`. `summaryLength` is within plausible bounds (1k–10k chars). |
| `compact_failed` | Does not fire. (Fail-open is the right behavior in production, but on these tapes it would indicate a regression in the summary path.) |

For a short tape that never crosses 60%:

| Event | Assertion |
|---|---|
| `compact_threshold_warned` | Does not fire. |
| `compact_started` | Does not fire. |

### Prune-anchor contract

After the first `compact_completed`:

- The original first user message is still present in the agent's context (assertion via direct context inspection — see "Inspection hooks" below).
- After a second `compact_completed` on the same session (nested compaction), the original first user message is **still** present (the load-bearing case from the A5b design doc).

### Safety-guard contract

For tapes where the recorded model behavior is well-formed:

| Event | Assertion |
|---|---|
| `guard_triggered` (`max_turns`) | Does not fire. |
| `guard_triggered` (`stuck_loop`) | Does not fire — unless the tape genuinely contains 3 identical consecutive tool calls, in which case it fires exactly once. |
| `guard_triggered` (`env_error_loop`) | Does not fire. |
| `empty_response_retry` | Fires only at the turns where the recorded assistant output is empty (preserves recorded behavior). |

### Parallel-batching contract

When the recorded assistant output contains ≥ 3 tool calls in one turn, the agent's bookkeeping does not split them across multiple LLM calls — observable via `tool_exec_start` count between consecutive `llm_call_end` events.

---

## Replay tape

A "tape" is a recorded session JSONL with two added invariants for replay use:

1. **Sealed at a known commit** — the file is checked in under `src/eval/replay-tapes/` and is not regenerated except by deliberate refresh (similar to D1 fixtures).
2. **Annotated with expected event counts** — a sidecar `tape-name.expected.json` records the assertions the tape is supposed to validate. This makes assertion drift visible in PR review: if a refactor changes the expected `compact_started` count, the diff shows up.

### Initial tape: `card_trade-2026-05-17`

Source: `/Users/zhijie/.opencli/projects/L1VzZXJzL3poaWppZS9Xb3Jrc3BhY2UvY2FyZF90cmFkZQ/2026-05-17T22-00-06-184.jsonl`

Shape: 662 entries, 1.6 MB. 42 user, 40 assistant, 290 tool_call, 289 tool_result. Spans multiple `/exit` + resume cycles. Recorded **before A5b shipped** — i.e. the trajectory is one where auto-compact *should have* fired but didn't. This makes it an ideal first tape: the recorded turn-by-turn token estimate crosses 75% somewhere mid-session, and current code should now fire `compact_started` at that point.

### Sealing the tape

Two things must happen before it's checked in:

1. **Redact secrets** — `web_fetch` outputs, environment values from `bash` outputs, any path that includes a user-specific home directory other than `/Users/zhijie`. A redaction script (`scripts/redact-tape.ts`) produces the sealed tape from the raw recording. The redaction map is checked in alongside so refreshes are deterministic.
2. **Pin the original cwd** — the recorded tape has `cwd: /Users/zhijie/Workspace/card_trade`. The replay does not chdir; assertions are against the event stream, not filesystem state.

---

## Mock client + mock tool execution

Two stubs, both standard test-double patterns already used elsewhere in the codebase (see [src/core/agent.test.ts](../../src/core/agent.test.ts) line ~80 for the `makeLoopingClient` pattern).

### `TapeClient implements LLMClient`

```typescript
class TapeClient implements LLMClient {
  constructor(private turns: RecordedTurn[]) {}
  private cursor = 0;
  async *stream(_messages: Message[], _sys: string, _tools: ToolDefinition[]) {
    const turn = this.turns[this.cursor++];
    if (!turn) throw new Error("tape exhausted");
    for (const event of turn.events) yield event;
  }
}
```

Where `RecordedTurn` is reconstructed from the JSONL by walking entries between consecutive `user`-role boundaries and emitting `StreamEvent`s that match what the original provider would have streamed: `text` chunks from `assistant.content`, `function_call` events from `tool_call`, terminating `done`.

The replay client **ignores** its input parameters (messages, system instruction, tools). This is the load-bearing design choice — we are testing the agent loop's bookkeeping under the recorded trajectory, not asking the model to re-decide. The downside is that we don't catch *"would the model still produce this trajectory under a changed prompt"* — that's the D3 SWE-bench question and is correctly out of scope here.

### `TapeRegistry extends ToolRegistry`

```typescript
class TapeRegistry extends ToolRegistry {
  constructor(private results: Map<TurnIndex, ToolResult[]>) { super(); }
  override async execute(name, args, _ctx) {
    const recorded = this.results.get(this.currentTurn)?.find(r => r.name === name);
    if (!recorded) throw new Error(`no recorded result for ${name} at turn ${this.currentTurn}`);
    return recorded.result;
  }
}
```

Tool calls return their recorded outputs verbatim. This preserves the **size and shape** of tool outputs — the load-bearing property for token-estimate trajectories — without requiring the original filesystem state. The agent loop sees the same context pressure it would have seen in real time.

---

## Inspection hooks

Two pieces of internal state need to be inspectable for the prune-anchor assertions:

1. **The current message list** between turns. The `Agent` class already holds context as a private field; we add `Agent.snapshotContext(): Message[]` (test-only, marked `@internal`) so the replay test can check whether the original first user message survives compactions. This does not change the public API surface.
2. **Whether a given message is the anchor**. The anchor lookup logic is already in [`src/core/context.ts`](../../src/core/context.ts); the replay test calls the same predicate.

Alternative considered: emit a new `ObservabilityEvent` for anchor-preserved/dropped. Rejected — the anchor is a derived property of the message list, not a discrete event. Snapshot inspection is cheaper and keeps the event taxonomy clean.

---

## Trajectory divergence

Because the tape was recorded before A5b, after the first auto-compaction fires during replay the agent's view of history is **truncated** (summary + recent), while the next recorded assistant turn was generated against the **full** history. The recorded turn's `text` and tool calls still play back — `TapeClient` doesn't know or care that history has changed — but assertions about post-divergence behavior become weaker.

**Decision: only assert pre-divergence properties on tapes recorded pre-A5b.** Specifically:

- `compact_threshold_warned` firing time: asserted (depends only on cumulative token estimate, monotonic before compaction).
- `compact_started` firing time: asserted (same reason).
- `compact_completed` follows `compact_started`: asserted (per-event invariant).
- Prune-anchor survives one compaction: asserted (single-shot property).
- Prune-anchor survives nested compactions: **deferred to a synthesized tape** (see "Synthesized tapes" below) — card_trade only fires once.
- Tool-call batching count per turn: asserted (per-turn property, independent of history truncation).

### Synthesized tapes

For assertions that need behaviors the real session doesn't exhibit (nested compactions, stuck-loop, env-error loop), small hand-written tapes live alongside the real ones under `src/eval/replay-tapes/synthesized/`. These are explicitly marked as synthesized and have richer `expected.json` annotations.

This is the same separation D1 uses between real-fixture scenarios (the YAML suite against `mini-ts/`) and edge-case fixtures (`mini-ts-partial/`).

---

## File layout

```
src/eval/
  replay/
    tape.ts                # reconstruct RecordedTurn[] from SessionEntry[]
    client.ts              # TapeClient
    registry.ts            # TapeRegistry
    runner.ts              # runTape(tapePath, expectedPath) → ReplayResult
    assertions.ts          # assertion DSL over ObservabilityEvent[]
    replay.test.ts         # vitest entry point — runs all sealed tapes
  replay-tapes/
    card-trade-2026-05-17.jsonl
    card-trade-2026-05-17.expected.json
    synthesized/
      nested-compaction.jsonl
      nested-compaction.expected.json
      ...
scripts/
  redact-tape.ts           # produce sealed tapes from raw session logs
```

---

## Test strategy for the harness itself

Same approach as D1's `scorer.test.ts`. Each module has a focused unit test:

- `tape.test.ts` — given a JSONL fragment, reconstructs the expected `RecordedTurn[]`. Covers session-resume merge, orphaned tool_result handling, multi-batch turns.
- `client.test.ts` — yields recorded events in order; throws on exhaustion.
- `registry.test.ts` — returns recorded results; throws on missing recordings.
- `assertions.test.ts` — given a synthetic event stream, fail/pass on expected counts and timing.
- `replay.test.ts` — runs the sealed tapes end-to-end; the assertions in `expected.json` drive the test.

---

## CI integration

`npm test` runs the replay test as part of the existing vitest run. No `OPENCLI_*` env vars required (replay is fully offline). Latency budget: replay one full real tape in < 5 s on developer hardware. The card_trade tape is the largest realistic input; if it grows past the budget, we shard.

---

## Out of scope

- **Forward-looking trajectory eval.** "Would the model under a changed prompt produce a reasonable trajectory?" is D3 / SWE-bench territory, not D2.
- **Multi-provider replay.** The tape is recorded against one provider; the agent loop's context-management contract is provider-independent. Replaying the same tape under different `LLMClient` wire formats would test format conversion, which is already unit-tested in each provider's own tests.
- **Auto-recording tapes from running sessions.** The redaction step is non-trivial; tapes are added manually by running `scripts/redact-tape.ts` on a JSONL the author has reviewed.

---

## Sequencing

| # | Step | Estimate |
|---|---|---|
| 1 | Build `TapeClient` + `TapeRegistry` + `runTape` skeleton | 0.5 day |
| 2 | Build assertion DSL + `assertions.test.ts` | 0.5 day |
| 3 | Write redaction script + seal `card-trade-2026-05-17` tape | 0.5 day |
| 4 | Author `card-trade-2026-05-17.expected.json` from a successful current-`main` run | 0.5 day |
| 5 | Add 2–3 synthesized edge-case tapes (nested compaction, stuck-loop, env-error loop) | 0.5 day |
| 6 | Wire into `npm test`; add tracking issue and link from roadmap | 0.5 day |

Total: ~3 days. Single PR is feasible; a 3-PR split (skeleton, real tape, synthesized tapes) is fine if the real-tape redaction surfaces complexity.

---

## File change summary

| Action | File |
|---|---|
| Create | `src/eval/replay/tape.ts` |
| Create | `src/eval/replay/client.ts` |
| Create | `src/eval/replay/registry.ts` |
| Create | `src/eval/replay/runner.ts` |
| Create | `src/eval/replay/assertions.ts` |
| Create | `src/eval/replay/*.test.ts` (one per module) |
| Create | `src/eval/replay/replay.test.ts` |
| Create | `src/eval/replay-tapes/card-trade-2026-05-17.jsonl` |
| Create | `src/eval/replay-tapes/card-trade-2026-05-17.expected.json` |
| Create | `src/eval/replay-tapes/synthesized/*.jsonl` + `.expected.json` |
| Create | `scripts/redact-tape.ts` |
| Modify | `src/core/agent.ts` — add `snapshotContext(): Message[]` for test inspection |
| Modify | `docs/roadmap.md` — link D2 design doc from D2 row |
| Modify | `package.json` — add `"test:replay": "vitest run src/eval/replay"` script (optional convenience) |
