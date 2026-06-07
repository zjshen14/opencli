# Replay tapes

Sealed session JSONL files used by [`src/eval/replay/replay.test.ts`](../replay/replay.test.ts) to validate the agent loop's context-management contract against real recorded shapes. Fully offline (no API calls). See [`docs/design/d2-context-management-replay.md`](../../../docs/design/d2-context-management-replay.md) for the full design.

## Tape format

A tape is a JSONL file with `SessionEntry` records (same format as `~/.opencli/projects/<encoded-cwd>/<session-id>.jsonl`), with two safeguards applied:

1. **Redacted** via [`scripts/redact-tape.ts`](../../../scripts/redact-tape.ts) — home paths and usernames replaced with deterministic placeholders. The sidecar `<tape>.jsonl.redaction-log.json` records what was replaced and how often, with a sha256 of the input so refreshes are reproducible.
2. **Annotated** with a sidecar `<tape>.expected.json` recording the observability event counts the tape's replay should produce. If a refactor changes the emission pattern in a way that matters, the diff lands in the `expected.json` and shows up in PR review.

## Current tapes

### `card-trade-2026-05-17`

| Field | Value |
|---|---|
| Source | `card_trade` session JSONL recorded 2026-05-17 → 2026-05-30 |
| Scope | Lines 33–105 of the redacted source — 4 react-mode user turns |
| User turns | "have you don your work?" → "could you continue" → "could you bring up the server…" → "actually can you kill the process binding port 3000…" |
| Why this slice | The full session contains 3 `/plan` invocations which produce back-to-back assistant entries (one for the plan-mode `agent.run()`, one for the implicit react-mode `agent.run()` that follows). The tape parser does not yet model that two-run pattern, so the truncation picks the longest continuous react-mode stretch with no `/plan`. |
| What it proves | Realistic call patterns replay cleanly — every recorded `tool_call`/`tool_result` pair is consumed in order, every observability event fires as expected, no guards misfire. Catches regressions on real trajectory shapes that hand-written tapes wouldn't surface. |
| What it doesn't prove | The session is too short (~11k token peak) to trigger A5b auto-compact. Compaction contract is asserted by the synthesized-pressure tapes in [`runner.test.ts`](../replay/runner.test.ts). |

### `synthesized/stuck-loop` and `synthesized/env-error-loop`

Two hand-written JSONL tapes covering safety-guard behaviours the real card_trade trajectory doesn't exercise. Small enough to inspect on PR diff (5–7 entries each); no redaction needed (no real paths or identifiers). Driven by [`src/eval/replay/synthesized.test.ts`](../replay/synthesized.test.ts).

| Tape | Asserts |
|---|---|
| `stuck-loop` | Three identical (name, args) tool calls in a row fire `guard_triggered('stuck_loop')`. Only iters 1+2 execute — iter 3 aborts before tool execution. |
| `env-error-loop` | Three consecutive tool results containing `EPERM` fire `guard_triggered('env_error_loop')`. All three iters execute; the guard fires AFTER the third. Args differ across iters so stuck-loop does not also fire. |

### `synthesized/plan-mode-write-block`

A hand-written JSONL tape covering the plan-mode contract. Driven by [`src/eval/replay/contract.test.ts`](../replay/contract.test.ts).

| Tape | Asserts |
|---|---|
| `plan-mode-write-block` | A `/plan`-prefixed turn containing a `write` call fires `tool_denied(plan_mode)` and produces zero `tool_exec_start` events — the write never reaches the registry. |

### Nested compaction (programmatic, lives in `synthesized.test.ts`)

The third synthesised case — two compactions in one replay, the second one nested inside the prune anchor preserved by the first — needs ≥ 500 KB of synthetic content (5 × 100 KB `read` results) to push the agent above the 75 % auto-compact threshold twice. Committing that as JSONL would bloat the repo for zero inspection value, so the tape is generated programmatically in the test. The assertion checks that the original user input survives both compactions via the verbatim-block anchor preservation in `extractOriginalTask`.

## Refreshing a tape

If you change the agent loop and the `expected.json` diff is legitimate (the new event count is correct), commit the change with a brief note about *why* the count changed. Reviewers should:

1. Cross-check that the diff matches the intent of the agent-loop change.
2. If the diff is unexpected, reproduce locally and investigate before approving.

## Adding a new tape

1. Capture a session JSONL.
2. Run `REDACT_USER=<your-username> tsx scripts/redact-tape.ts <input>.jsonl src/eval/replay-tapes/<name>.jsonl`.
3. Inspect the `.redaction-log.json` and confirm the replacement counts are reasonable.
4. Run `npx vitest run src/eval/replay/replay.test.ts` to see the observability counts; copy them into a new `<name>.expected.json`.
5. Add the tape to the `describe` block in `replay.test.ts`.
6. Commit the tape + log + expected + this README's table.
