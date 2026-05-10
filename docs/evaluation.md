# OpenCLI Evaluation Strategy

_Last updated: 2026-05-09_

This document defines OpenCLI's evaluation strategy — what we measure, why, and in what order. It is paired with [Roadmap Phase D](roadmap.md#phase-d--evaluation) for milestone tracking.

## Goal

Publish SWE-bench Verified numbers that are competitive with Claude Code and Codex CLI, while also shipping a unique cross-provider parity benchmark that no other agent publishes today. The second artifact is the differentiating one — any agent can cite SWE-V; only a genuinely multi-provider agent can demonstrate cross-vendor parity.

## What we measure

Three surfaces, each tied to a project angle:

### Surface 1 — Functional correctness

"Given a task, does the agent complete it?" Measured by scenario tests (internal) and SWE-bench Verified (public). This is _defensive_ — we need to not fall embarrassingly behind the field — but it is not where OpenCLI differentiates.

### Surface 2 — Cross-provider parity

The same task suite run against Anthropic / Gemini / OpenAI / Kimi / Qwen. Output: a parity matrix showing per-provider pass rate on each scenario. **Nobody publishes this today.** A clean parity matrix with a narrow interquartile range across providers is the best concrete evidence that Angle 1 ("provider-agnostic") is real and not just a config flag.

### Surface 3 — Contract evals

Pass/fail evals for properties that must hold at 100% — not statistical:

| Property | What a failure looks like |
|---|---|
| Sandbox deny (network) | `curl https://example.com` succeeds inside sandbox |
| Sandbox deny (write-outside-CWD) | Write to `/etc/hosts` succeeds inside sandbox |
| Plan mode read-only | A write tool executes during a plan pass |
| HITL gate | A `requiresConfirmation` tool runs without prompt |
| Stuck-loop guard | Agent makes 4+ identical consecutive calls |
| Headless schema | JSON event stream emits an unrecognised event type |
| MCP HITL | An MCP tool fires without confirmation |

These are binary. Any failure is a regression. They run on every PR.

---

## Benchmark landscape

| Benchmark | What it tests | Our stance |
|---|---|---|
| **SWE-bench Verified** (500 tasks) | Real GitHub issues across 12 Python repos. The de facto public leaderboard. | **D3 target — publish here post-B5.** |
| **SWE-bench Lite** (300 tasks) | Subset of SWE-V; used for faster iteration. | **D3 gating — run on every release candidate.** |
| **Terminal-Bench** (260 tasks) | Terminal task completion — file ops, debugging, system admin. Directly matches OpenCLI's surface. | **Include in D1 scenario set** as a source of task ideas; full harness integration at D3 if SWE-V proves insufficient. |
| **Aider Polyglot Leaderboard** | Refactoring across 6 languages with diff-format scoring. | **Track passively** — Aider publishes the harness; run periodically. Not a CI target. |
| **LiveCodeBench** | Competitive programming. | Skip — not agent-shaped for our use case. |
| **HumanEval / MBPP** | Single-function code generation. | Skip — too narrow, saturated, doesn't distinguish agents. |
| **METR autonomy tasks** | Long-horizon multi-hour tasks. | Premature — revisit when C5 (sub-agent dispatch) ships. |

---

## Phase D — Milestones

### D0 — Eval foundation _(now)_

**Goal:** know what we already have; publish the scoring rubric.

- Document which existing unit tests contribute to each surface (mostly Surface 3 primitives: executor guards, plan mode, HITL).
- Define the pass/fail criteria and scoring formula for D1 scenarios (spec below).
- Publish `docs/evaluation.md` (this file) as the canonical reference.

**Output:** this doc + a gap list of what unit tests are missing for Surface 3.

### D1 — Scenario suite + provider parity matrix _(before Phase B starts)_

**Goal:** a fast CI loop that catches regressions across providers before any B-phase work begins.

**Scope:** 20 hand-written scenarios in `src/eval/scenarios/`, run via `vitest` against all configured providers. Full matrix in ~10 min on CI (parallelised per provider). Runs on every PR.

**Task distribution:**

| Category | Count | Example |
|---|---|---|
| Read + explain | 4 | "Summarise what `src/core/agent.ts` does" |
| Bug fix | 5 | Given a file with a deliberate syntax/logic error, fix it |
| Feature add | 5 | "Add a `--quiet` flag that suppresses tool output" |
| Refactor | 3 | "Extract the retry logic in X into a shared helper" |
| Multi-file | 3 | Tasks that require reading + editing 2+ files |

**Scoring per task:**

```
pass  = expected file state achieved OR expected output keywords present
partial = some files correct, some not (only for multi-file tasks)
fail  = timeout, wrong output, agent got stuck
```

**Parity matrix output** (published to CI summary on every run):

```
                 anthropic   gemini   openai
explain-agent      pass       pass     pass
fix-syntax-err     pass       fail     pass
add-quiet-flag     pass       pass    partial
...
PASS RATE           95%        75%      85%
```

A provider that drops more than 15 percentage points below the leading provider triggers a CI warning (not failure — flaky providers shouldn't block PRs).

**Harness:** `src/eval/runner.ts` spawns `opencli run "<prompt>" --model <model>` in a fixture directory (git-clean temp clone), captures stdout + final FS state. Scorer compares against YAML-defined expected state. No custom eval framework — just vitest + Node `child_process`.

### D2 — Contract evals _(alongside A6)_

**Goal:** every Surface 3 property is covered by a deterministic, fast (<30s) test on every PR.

Contract tests live in `src/eval/contracts/`:

- `sandbox.eval.ts` — 10 commands that should be denied; 10 that should pass. Run against `SandboxExecRunner` and `BwrapRunner` directly.
- `plan-mode.eval.ts` — agent runs in plan mode against 5 tasks; none may produce writes.
- `hitl.eval.ts` — tools marked `requiresConfirmation` must never execute in non-interactive mode without `--yes`.
- `stuck-loop.eval.ts` — a mock tool that always fails; agent must abort within `STUCK_THRESHOLD` turns.
- `headless.eval.ts` — parse `--output=json` stream for 5 tasks; validate schema for every event.
- `mcp-hitl.eval.ts` — MCP tool fires in non-interactive mode without `--yes`; must be denied.

All contract evals return pass/fail with no partial scoring. A single failure is a CI block.

### D3 — SWE-bench Verified harness _(after B5a ships)_

**Goal:** a public, independently-reproducible number on the de facto industry benchmark.

**Why after B5a, not earlier:** SWE-V needs a stable agent. Before multi-provider routing is settled, we're not sure which provider is "our" agent. After B5a, we have a defined default (Anthropic for architect, Gemini for edit, or whichever config we land on) worth benchmarking.

**Harness architecture:**

SWE-V expects an agent that:
1. Receives an issue description + a Docker container with the repo checked out at the failing commit.
2. Runs autonomously and outputs a patch (git diff).

OpenCLI fits this via:
```
docker run <swe-bench-container> \
  opencli run "<issue text>" --sandbox off --yes --max-turns 30 \
  && git diff > patch.diff
```

The `--yes` flag auto-approves HITL, `--sandbox off` trusts the container isolation, `--max-turns 30` caps cost. This is the same invocation Codex CLI uses.

**Cadence:**
- **SWE-bench Lite (300 tasks):** run on every release candidate (manual trigger). ~$30 per run.
- **SWE-bench Verified (500 tasks):** run quarterly or before any public benchmark claim. ~$100–200 per run.

**Target:** at D3 launch, aim for >20% pass rate on Lite. Competitive agents (Claude Code, Codex) are in the 40–60% range; we need to get on the board, not beat them immediately. Track trajectory over time.

### D4 — Custom cross-provider routing benchmark _(after B5b ships)_

**Goal:** a publishable benchmark that no other agent can run — comparing single-vendor vs cross-vendor routing on a fixed task set.

**Design (preliminary; full spec deferred to D4 design doc):**

- Same 20 D1 scenarios + 10 harder multi-step tasks.
- Run four configurations:
  1. All-Anthropic (Claude Opus architect + editor)
  2. All-Gemini
  3. All-OpenAI
  4. Cross-vendor: Opus architect + Gemini 2.5 editor (B5b mode)
- Measure: pass rate, cost (USD), latency (p50/p95).
- Hypothesis: cross-vendor routing matches or exceeds any single-vendor on pass rate at lower cost.

If the hypothesis holds, this is a publishable result. If it doesn't, that's equally useful — it tells us where cross-vendor routing fails and guides B5b improvement.

**Output artifact:** a reproducible benchmark script + a published report (blog post / paper). This is the marquee differentiating eval.

---

## Tooling

| Component | Implementation |
|---|---|
| Scenario runner | `src/eval/runner.ts` — wraps `opencli run` via `child_process.spawn`; manages fixture dirs |
| Scorer | `src/eval/scorer.ts` — YAML-defined expected state; file-diff + keyword matchers |
| Scenario definitions | `src/eval/scenarios/*.yaml` — 20 tasks, each with fixture + expected |
| Provider matrix | `src/eval/matrix.test.ts` — `describe.each(providers)` × scenarios |
| Contract evals | `src/eval/contracts/*.eval.ts` — unit-style, deterministic, no LLM calls |
| SWE-V wrapper | `scripts/swebench-run.sh` — Docker + `opencli run` harness; separate from vitest |
| CI integration | D1 (scenario matrix): `npm run eval` — slow CI job, manual trigger on PRs; auto on release. D2 (contracts): `npm test` — runs with every PR. D3 (SWE-V): manual trigger only. |

`npm run eval` is distinct from `npm test` — the former makes real API calls and costs money; the latter is fully offline. The distinction is documented in `CLAUDE.md`.

---

## Sequencing decisions

**D1 before Phase B starts.** Provider parity must be measured before we build multi-provider features. Without a baseline, we can't tell if B-work improves or regresses parity. D1 is also the cheapest eval to build and the one that gives the fastest feedback loop.

**D2 alongside A6, not A1.** Contract evals for sandbox and plan mode can't be written until the features exist. A6 is the last A-phase milestone; by then all A-phase properties are testable.

**D3 after B5a, not before.** Running SWE-V before we have a defined "best configuration" gives us a noisy number tied to a configuration we'll change. Post-B5a, the default config is stable enough to publish against.

**D4 is research, not quality gating.** It exists to produce a publishable artifact for B5b, not to gate any PR. It runs once per B5b iteration, not continuously.

---

## Decisions still open

1. **D1 provider list.** Which providers should be in the D1 matrix from day one? Anthropic and Gemini are obvious; OpenAI too once B2 matures. Kimi and Qwen need B1 (proxy plumbing) and B6. Recommendation: start with Anthropic + Gemini; expand as each provider's client stabilises.

2. **D3 baseline provider.** SWE-V runs require picking one config. Recommended: Anthropic Claude Sonnet for D3 (closest to what SWE-V existing scores are measured on; apples-to-apples comparison). Switch to cross-vendor for D4.

3. **Cost governance.** D1 costs ~$1–5 per full run (20 tasks × N providers × token cost). D3 costs ~$100–200. Who approves D3 runs? Recommendation: repo maintainer manually triggers; budget tracked in a simple `docs/eval-costs.md` log.
