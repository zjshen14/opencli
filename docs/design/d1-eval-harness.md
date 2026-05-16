# Design: D1 — Scenario suite + cross-provider parity matrix

_Status: Implemented — merged in 976409e (2026-05-15). Tracking issue: [#90](https://github.com/zjshen14/opencli/issues/90). Phase: [Roadmap D1](../roadmap.md#phase-d--evaluation)._

---

## Goal

A fast evaluation loop that runs 20 hand-written scenarios against all configured providers, produces a parity matrix, and catches regressions before B-phase work ships. This establishes the baseline required by the roadmap's sequencing rule: **D1 before Phase B starts.**

`npm run eval` is the entry point. It makes real API calls and costs money (~$1–5 per full run). It is intentionally separate from `npm test`, which is fully offline.

---

## Framework evaluation — why custom

Three off-the-shelf frameworks were evaluated. A 1-day spike on promptfoo was run before committing (see [#90 spike verdict](https://github.com/zjshen14/opencli/issues/90#issuecomment-4465071961)).

**promptfoo** (TS-native, YAML-driven, multi-provider) is the closest fit. It has YAML scenarios, multi-provider matrix views, an assertion DSL, cost tracking, CI integration, and a result-diff UI. The `type: javascript` assertion gives arbitrary access to provider-returned context — filesystem-state scoring is not fighting the framework, it uses the documented extension point. The spike validated this for single-file scenarios (192 lines of glue, clean entry point, readable matrix output).

The blocker is **list-vars expansion**: when a YAML `vars` field contains a list, promptfoo creates separate test cases for each list item rather than passing the array to the provider. This breaks multi-file scenarios — the ones that check two or more output files in a single assertion. The workaround (serialize to a JSON string, parse in the provider) leaks framework internals into the YAML and was not documented. Three of our 20 scenarios are multi-file and specifically the hardest cases. This met the spike's pre-stated "keep custom" criterion: *"the provider context passing required undocumented workarounds."*

**inspect_ai** (UK AISI) is the strongest agentic eval framework with proper tool-use and sandboxed execution support. Python-only — a permanent toolchain split for a TypeScript project.

**Decision: custom.** The list-vars issue is structural, not incidental — it reflects how promptfoo's matrix generation is designed. The custom harness handles multi-file scenarios naturally via `string | string[]` in the scenario schema. The promptfoo spike is preserved in `scripts/` as a reference for single-file use cases and a starting point if promptfoo fixes list-vars handling in a future release.

---

## File layout

```
src/eval/
  runner.ts          # runScenario(scenario, model, opts?) → RunResult
  scorer.ts          # scoreScenario(scenario, result) → ScoreResult
  report.ts          # formatMatrix(results) → { markdown, json }
  config.ts          # configuredProviders() → { label, model }[]
  matrix.test.ts     # describe.each(providers) × describe.each(scenarios)
  scenarios/
    *.yaml           # 20 scenario definitions (schema below)
  fixtures/
    mini-ts/         # primary shared fixture — clean TS project
    mini-ts-bugs/    # same project with deliberate defects
    mini-ts-partial/ # same project with incomplete features
    multi-file/      # slightly larger fixture for multi-file tasks
```

---

## Scenario YAML schema

```yaml
id: string                  # unique, kebab-case
category: read-explain | bug-fix | feature-add | refactor | multi-file
description: string         # human-readable, one line
prompt: string              # exact string sent to `opencli run`
fixture: string             # directory name under src/eval/fixtures/
expected:
  # For read-explain — all keywords must appear somewhere in stdout:
  outputKeywords?: string[]
  # For bug-fix / feature-add / refactor / multi-file — file state checks:
  files?:
    <relative-path>:
      contains?: string | string[]  # ALL substrings must appear (AND semantics)
      notContains?: string          # this substring must be absent
      exists?: boolean              # file must exist (default true when key is present)
```

`contains` accepts either a bare string or an array — all entries are required. String comparisons are case-sensitive and match anywhere in the file. The schema validator (`loadScenarios`) rejects files with invalid YAML at startup.

---

## Scoring

```
pass    — all expected criteria satisfied AND (if code-modifying) tsc --noEmit exits 0
partial — ≥ 50 % of expected.files checks pass (multi-file tasks only)
fail    — timeout, non-zero agent exit, tsc type errors, no outputKeywords matched,
          or < 50 % file checks pass
```

### TypeScript compilation gate

After every code-modifying scenario (category ≠ `read-explain`), the runner runs `tsc --noEmit` using the fixture's `tsconfig.json`. If this exits non-zero, the score is `fail` regardless of `contains` results. This catches the largest class of bad agent outputs — syntax errors, wrong imports, type mismatches — at near-zero cost.

```typescript
// In scoreScenario(), after string checks:
if (result.typeErrors) {
  return { score: "fail", reason: `tsc errors: ${result.typeErrors.slice(0, 200)}` };
}
```

`scorer.ts` never runs `tsc` itself — the runner populates `result.typeErrors` before returning.

`scoreScenario` returns `{ score: "pass" | "partial" | "fail", reason: string }`.

---

## Runner

### Binary resolution

```typescript
const DIST_ENTRY = resolve(new URL(".", import.meta.url).pathname, "../../../dist/index.js");
```

Same pattern as `src/cli/run.smoke.test.ts`. Tests are skipped when the binary does not exist — add a top-level note: "Run `npm run build` first."

### Temperature — determinism prerequisite

Running stochastic LLMs at default temperature will produce flaky CI. A cheap model at 60% reliability on a scenario will fail ~3 times in 60 runs. The runner passes `--temperature 0` to every `opencli run` invocation.

**This requires adding `--temperature <float>` to the CLI.** This is a small scope addition included in D1 implementation:
- Add `--temperature` option to `opencli run` in `cli/index.ts`
- Thread it through `createClient()` and each provider client's `stream()` call
- Gemini, Anthropic, and OpenAI all honour `temperature: 0` in their APIs

### Retry budget

Even at temperature 0, some providers exhibit residual stochasticity on borderline tasks. Each scenario is retried up to **2 times** on failure — persistent failures are marked `fail`, intermittent passes count as pass.

```typescript
const MAX_RETRIES = 2;
for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
  const result = await runScenarioOnce(scenario, model, tmpDir);
  const { score } = scoreScenario(scenario, result);
  if (score !== "fail") return { result, score };
}
return { result: lastResult, score: "fail" };
```

Retry does not multiply cost in practice: most passes succeed on the first attempt.

### `runScenario` steps

1. Create temp dir: `mkdtemp(join(tmpdir(), "opencli-eval-"))`
2. Copy fixture: `await fs.cp(fixtureDir, tmpDir, { recursive: true })` (cross-platform; requires Node 20+, which is already the project minimum)
3. Init git:
   ```
   git init
   git -c user.email=eval@opencli -c user.name=eval add .
   git -c user.email=eval@opencli -c user.name=eval commit -m "fixture"
   ```
   Explicit git identity avoids failures on fresh CI containers without global user config.
4. Spawn: `node <DIST_ENTRY> run "<prompt>" --model <model> --yes --max-turns 20 --temperature 0`
   - `cwd`: temp dir
   - `env`: `{ ...process.env }` (inherits API keys)
   - For scenarios in `sandboxScenarios` set: omit `--sandbox off` (uses default `auto`)
   - For all others: `--sandbox off` (avoids filesystem permission issues in temp dirs)
   - Timeout: 120 s via `AbortController`
5. Capture combined stdout as `output: string`; capture stderr separately
6. After process exits, run `tsc --noEmit` using the fixture's `tsconfig.json`; capture exit code and stderr as `typeErrors`
7. Read final FS state for all paths mentioned in `expected.files`
8. `rm -rf` temp dir
9. Return `RunResult`

```typescript
export interface RunResult {
  output: string;
  files: Record<string, string | null>;  // null = does not exist
  typeErrors: string | null;             // null = clean; non-null = tsc stderr
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  tokenUsage?: { input: number; output: number };
}
```

Token usage is extracted from the `--output=json` stream when that flag lands (C1). Until then, the field is omitted.

---

## Provider configuration

```typescript
// src/eval/config.ts
export interface Provider {
  label: string;  // "anthropic" | "gemini" | "openai"
  model: string;
}

export function configuredProviders(): Provider[] {
  const providers: Provider[] = [];
  if (process.env.ANTHROPIC_API_KEY)
    providers.push({ label: "anthropic", model: process.env.EVAL_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001" });
  if (process.env.GEMINI_API_KEY)
    providers.push({ label: "gemini", model: process.env.EVAL_GEMINI_MODEL ?? "gemini-2.0-flash-lite" });
  if (process.env.OPENAI_API_KEY)
    providers.push({ label: "openai", model: process.env.EVAL_OPENAI_MODEL ?? "gpt-4o-mini" });

  if (providers.length === 0) {
    throw new Error(
      "No eval providers configured — set at least one of ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY"
    );
  }
  return providers;
}
```

Note: the OpenAI provider client (`src/providers/openai.ts`) already exists — it shipped with B1. All three providers are available from day one.

Provider models are overridable via env vars. Defaults are the cheapest capable models for each provider.

---

## Matrix test

```typescript
// src/eval/matrix.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { configuredProviders } from "./config.js";
import { loadScenarios } from "./scenarios.js";
import { runScenario } from "./runner.js";
import { scoreScenario } from "./scorer.js";
import { formatMatrix } from "./report.js";

let providers: Provider[];
let scenarios: Scenario[];
const matrix: Record<string, Record<string, string>> = {};

beforeAll(async () => {
  providers = configuredProviders();
  scenarios = await loadScenarios();
});

describe.each(() => providers)("provider: $label ($model)", ({ label, model }) => {
  describe.each(() => scenarios)("$id", (scenario) => {
    it(scenario.description, { timeout: 130_000 }, async () => {
      const { score, result } = await runScenario(scenario, model);
      const { reason } = scoreScenario(scenario, result);
      matrix[scenario.id] ??= {};
      matrix[scenario.id][label] = score;
      if (score === "fail") {
        console.log(`[${label}] ${scenario.id} FAIL: ${reason}`);
      }
      expect(score, reason).not.toBe("fail");
    });
  });
});

afterAll(() => {
  if (Object.keys(matrix).length === 0) return;
  const providerLabels = providers.map((p) => p.label);
  const { markdown, json } = formatMatrix(matrix, providerLabels);
  console.log("\n" + markdown);
  const outPath = process.env.EVAL_JSON_OUT;
  if (outPath) writeFileSync(outPath, JSON.stringify(json, null, 2));
});
```

Use `beforeAll` for scenario loading — more conventional than top-level await and compatible with all Vitest versions.

### Parallelization

Vitest runs test files in parallel by default. Within the matrix file, `describe.each(providers)` creates one describe block per provider — these run sequentially within the file, but providers can be split across workers if needed. For D1 (3 providers, 20 scenarios), sequential is fine; total wall-clock at 5 s/scenario average is ~5 min. At 120 s timeout worst-case per scenario: 20 × 3 × 120 s = 120 min. In practice expect 10–20 min. Document in `README` under `npm run eval`.

---

## Report and JSON artifact

```typescript
export interface MatrixJson {
  timestamp: string;
  providers: string[];
  scenarios: Array<{
    id: string;
    category: string;
    results: Record<string, "pass" | "partial" | "fail">;
  }>;
  passRates: Record<string, number>;  // provider → 0–1
}

export function formatMatrix(
  matrix: Record<string, Record<string, string>>,
  providers: string[],
): { markdown: string; json: MatrixJson }
```

`EVAL_JSON_OUT=path/to/out.json npm run eval` writes the artifact. CI can diff two JSON files to detect regressions:

```bash
jq '.passRates' before.json
jq '.passRates' after.json
```

---

## Parity warning

`formatMatrix` appends a warning line if any provider drops more than 15 percentage points below the leading provider:

```
⚠  gemini pass rate (75%) is 20pp below leading provider (anthropic 95%)
```

Console warning only — does not fail the suite. Purpose is visibility in CI summary, not a gate.

---

## Sandbox scenarios

Running all scenarios with `--sandbox off` means D1 does not baseline the A1 sandbox feature. Two scenarios run with default sandbox (`auto`) instead:

- `explain-math-module` (read-only, no filesystem writes — safe with sandbox on)
- `fix-off-by-one` (writes one file — tests that sandbox permits CWD writes)

These are marked in their YAML with `sandbox: auto`. The runner omits `--sandbox off` for those scenario IDs.

---

## `npm run eval` script

Add to `package.json`:
```json
"eval": "vitest run src/eval/matrix.test.ts --reporter=verbose"
```

---

## Fixtures

### `mini-ts/` — clean project (used by read-explain and feature-add)

```
src/
  math.ts     — exports add(a, b), subtract(a, b), multiply(a, b) with JSDoc
  utils.ts    — exports clamp(v, lo, hi), isEven(n), sum(arr), capitalize(s)
  counter.ts  — exports Counter class: increment(), decrement(), value getter
  task.ts     — exports Task interface { id, title, done }, createTask(title) factory
tsconfig.json — strict mode, module ESNext, noEmit false
package.json  — name: "mini-ts", type: "module", no dependencies
```

### `mini-ts-bugs/` — same project with deliberate defects

Each bug is isolated, obvious from context, and has a specific correct fix string:

| Scenario | File | Bug | Expected fix |
|---|---|---|---|
| `fix-off-by-one` | `counter.ts` | `get value() { return this._count - 1; }` | `return this._count` without subtraction |
| `fix-subtract-operator` | `math.ts` | `subtract(a, b) { return a + b; }` | `a - b` |
| `fix-null-guard` | `utils.ts` | `sum(arr) { return arr.reduce((a, b) => a + b); }` | add initial value `0` to reduce call |
| `fix-missing-return` | `task.ts` | `if (!title) { console.error("bad"); }` with no return | `return null` in the guard branch |
| `fix-strict-equality` | `utils.ts` | `capitalize(s) { if (s == "") return s; }` | `===` instead of `==` |

The bug strings are unique within their files — no false-positive `notContains` matches.

### `mini-ts-partial/` — project with intentional gaps

| Scenario | File | What's missing / wrong |
|---|---|---|
| `add-clamp-function` | `math.ts` | `clamp` function absent |
| `add-power-function` | `math.ts` | `power` function absent |
| `add-input-validation` | `math.ts` | `add()` has no type guard |
| `add-version-constant` | `utils.ts` | No `VERSION` export |
| `add-counter-reset` | `counter.ts` | No `reset()` method |
| `extract-duplicate-validation` | `utils.ts` | Two copies of: `if (typeof v !== "number") throw new TypeError(...)` — extracted helper should be named `assertNumber` |
| `rename-internal-variable` | `counter.ts` | State stored in `this.x` throughout |
| `split-long-function` | `task.ts` | `processTask()` is 40+ lines; must split into `validateTask()` + `executeTask()` |

### `multi-file/` — slightly expanded project for multi-file tasks

```
src/
  math.ts       — same as mini-ts but no test file
  formatter.ts  — ABSENT (agent must create it)
  task.ts       — Task interface missing `description` field
  task.impl.ts  — createTask() factory (must be updated with interface)
tsconfig.json
package.json
```

---

## The 20 scenarios

### Read + explain (4)

```yaml
id: explain-math-module
category: read-explain
sandbox: auto
description: Describe exports of math.ts
prompt: "Describe what src/math.ts exports and what each function does."
fixture: mini-ts
expected:
  outputKeywords: ["add", "subtract", "multiply"]
```

```yaml
id: explain-counter-class
category: read-explain
description: Describe the Counter class and its methods
prompt: "What class does src/counter.ts define? List its methods and describe what each does."
fixture: mini-ts
expected:
  outputKeywords: ["Counter", "increment", "decrement", "value"]
```

```yaml
id: list-util-exports
category: read-explain
description: List exported function names from utils.ts
prompt: "List all exported function names from src/utils.ts."
fixture: mini-ts
expected:
  outputKeywords: ["clamp", "isEven", "sum", "capitalize"]
```

```yaml
id: explain-task-interface
category: read-explain
description: Describe the Task interface fields
prompt: "What fields does the Task interface in src/task.ts have? What does createTask() return?"
fixture: mini-ts
expected:
  outputKeywords: ["id", "title", "done"]
```

### Bug fix (5)

```yaml
id: fix-off-by-one
category: bug-fix
sandbox: auto
description: Fix Counter.value getter returning count - 1
prompt: "There is a bug in src/counter.ts — the value getter returns one less than expected. Fix it."
fixture: mini-ts-bugs
expected:
  files:
    src/counter.ts:
      contains: "return this._count"
      notContains: "this._count - 1"
```

```yaml
id: fix-subtract-operator
category: bug-fix
description: Fix subtract() returning sum instead of difference
prompt: "The subtract function in src/math.ts returns the wrong result — it adds instead of subtracts. Fix it."
fixture: mini-ts-bugs
expected:
  files:
    src/math.ts:
      contains: "a - b"
      notContains: "a + b"
```

```yaml
id: fix-null-guard
category: bug-fix
description: Fix sum() crashing on empty array
prompt: "src/utils.ts sum() crashes when called with an empty array. Fix it so it returns 0."
fixture: mini-ts-bugs
expected:
  files:
    src/utils.ts:
      contains: ", 0)"
      notContains: "arr.reduce((a, b) => a + b)"
```

```yaml
id: fix-missing-return
category: bug-fix
description: Fix createTask() branch that falls off without returning
prompt: "createTask() in src/task.ts has a branch that runs console.error but doesn't return anything for invalid input. Fix it to return null."
fixture: mini-ts-bugs
expected:
  files:
    src/task.ts:
      contains: "return null"
```

```yaml
id: fix-strict-equality
category: bug-fix
description: Fix capitalize() using == instead of ===
prompt: "capitalize() in src/utils.ts uses loose equality for an empty-string check. Fix it to use strict equality."
fixture: mini-ts-bugs
expected:
  files:
    src/utils.ts:
      contains: '=== ""'
      notContains: '== ""'
```

### Feature add (5)

```yaml
id: add-clamp-function
category: feature-add
description: Add clamp() to math.ts
prompt: "Add a clamp(value: number, min: number, max: number): number function to src/math.ts that returns value constrained to [min, max]."
fixture: mini-ts-partial
expected:
  files:
    src/math.ts:
      contains: "clamp"
```

```yaml
id: add-power-function
category: feature-add
description: Add power() to math.ts
prompt: "Add a power(base: number, exp: number): number function to src/math.ts."
fixture: mini-ts-partial
expected:
  files:
    src/math.ts:
      contains: "power"
```

```yaml
id: add-input-validation
category: feature-add
description: Add type guard to add()
prompt: "Add input validation to add() in src/math.ts: throw a TypeError if either argument is not a number."
fixture: mini-ts-partial
expected:
  files:
    src/math.ts:
      contains: ["typeof", "TypeError"]
```

```yaml
id: add-version-constant
category: feature-add
description: Export a VERSION constant from utils.ts
prompt: "Add an exported VERSION constant set to '1.0.0' in src/utils.ts."
fixture: mini-ts-partial
expected:
  files:
    src/utils.ts:
      contains:
        - "VERSION"
        - "'1.0.0'"
```

```yaml
id: add-counter-reset
category: feature-add
description: Add reset() method to Counter
prompt: "Add a reset() method to the Counter class in src/counter.ts that sets the count back to zero."
fixture: mini-ts-partial
expected:
  files:
    src/counter.ts:
      contains: "reset"
```

### Refactor (3)

```yaml
id: extract-duplicate-validation
category: refactor
description: Extract repeated type-guard blocks into assertNumber()
prompt: "src/utils.ts has two identical validation blocks that check if a value is a number. Extract the duplicated logic into a helper function called assertNumber and call it from both places."
fixture: mini-ts-partial
expected:
  files:
    src/utils.ts:
      contains: "assertNumber"
```

```yaml
id: rename-internal-variable
category: refactor
description: Rename this.x to this.count in counter.ts
prompt: "The internal state in src/counter.ts is stored in a variable named 'x'. Rename it to 'count' throughout the file."
fixture: mini-ts-partial
expected:
  files:
    src/counter.ts:
      contains: "this.count"
      notContains: "this.x"
```

```yaml
id: split-long-function
category: refactor
description: Split processTask() into validateTask() + executeTask()
prompt: "processTask() in src/task.ts is too long. Split it into validateTask() (handles validation) and executeTask() (handles execution), and have processTask() call both in sequence."
fixture: mini-ts-partial
expected:
  files:
    src/task.ts:
      contains: ["validateTask", "executeTask"]
```

### Multi-file (3)

```yaml
id: add-math-tests
category: multi-file
description: Write a test file for math.ts
prompt: "Write tests for all functions in src/math.ts. Save them to src/math.test.ts. Test at least one happy-path and one edge case per function."
fixture: multi-file
expected:
  files:
    src/math.test.ts:
      exists: true
      contains: ["add", "subtract", "multiply"]
```

```yaml
id: create-and-wire-formatter
category: multi-file
description: Create formatter.ts and import it from utils.ts
prompt: "Create src/formatter.ts with a format(value: number): string function that formats numbers with two decimal places. Then import and use format() in src/utils.ts."
fixture: multi-file
expected:
  files:
    src/formatter.ts:
      exists: true
      contains: "format"
    src/utils.ts:
      contains: "formatter"
```

```yaml
id: update-interface-and-impl
category: multi-file
description: Add description field to Task interface and update factory
prompt: "Add a 'description: string' field to the Task interface in src/task.ts. Update createTask() in src/task.impl.ts to accept a description parameter and set it."
fixture: multi-file
expected:
  files:
    src/task.ts:
      contains: "description"
    src/task.impl.ts:
      contains: "description"
```

---

## Implementation notes

### Scenario loading (`loadScenarios`)

```typescript
import { readdir, readFile } from "node:fs/promises";
import { parse } from "yaml";  // already a project dependency

export async function loadScenarios(): Promise<Scenario[]> {
  const dir = join(new URL(".", import.meta.url).pathname, "scenarios");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml"));
  return Promise.all(
    files.map(async (f) => parse(await readFile(join(dir, f), "utf8")) as Scenario)
  );
}
```

### `--temperature` CLI flag (prerequisite)

Add to `opencli run` in `cli/index.ts`:
```
--temperature <float>   LLM temperature (default: provider default; use 0 for determinism)
```

Thread through `createAgent` → `createClient` → each provider's `stream()` call. All three current providers accept `temperature` in their API request.

### Skipping when binary not built

```typescript
const CLI_BUILT = existsSync(DIST_ENTRY);
if (!CLI_BUILT) {
  it.skip("dist/index.js not found — run `npm run build` first");
}
```

---

## Test strategy for the harness itself

Harness components are tested offline — no real API calls:

| Test | File | What it proves |
|---|---|---|
| `scoreScenario` pass: all keywords present | `scorer.test.ts` | Keyword match |
| `scoreScenario` fail: keyword missing | same | Miss detection |
| `scoreScenario` fail: typeErrors non-null | same | tsc gate |
| `scoreScenario` pass: file contains expected string | same | File match |
| `scoreScenario` pass: file contains all entries in contains[] | same | Array AND semantics |
| `scoreScenario` partial: 1/2 files match | same | Partial scoring |
| `formatMatrix` renders correct column widths | `report.test.ts` | Table output |
| `formatMatrix` emits 15pp warning when threshold breached | same | Parity alert |
| `formatMatrix` json field has correct schema | same | JSON artifact |
| `configuredProviders` throws when no keys set | `config.test.ts` | Empty-list guard |
| `configuredProviders` returns only providers with keys set | same | Env var detection |
| `runScenarioOnce` copies fixture and returns RunResult | `runner.test.ts` | Integration (mock opencli script that exits 0) |

These live in `src/eval/*.test.ts` and run as part of `npm test` (no API calls).

---

## CI integration

| Command | When | Cost |
|---|---|---|
| `npm test` | Every PR (automated) | Free — harness unit tests only |
| `npm run eval` | Manual trigger on PRs; auto on release | ~$1–5 per full run (~10–20 min at 5 s/scenario avg) |

`EVAL_JSON_OUT=results.json npm run eval` writes a machine-readable artifact for regression diffing. CI can archive this and compare to the previous release using `jq '.passRates'`.

---

## Future migration path

The custom harness will evolve incrementally. Concrete trigger conditions — if any of these occur, evaluate the feature or a promptfoo migration before adding more custom code:

| Trigger | Action |
|---|---|
| Debugging a single failing scenario takes > 5 min | Add `--scenario <id>` filter flag to `npm run eval` |
| ≥ 3 scenarios are flagged as too brittle for `contains` checks | Introduce LLM-as-judge scoring path in `scorer.ts` |
| Scenario count exceeds 40 | Build a minimal result viewer / trend tracker, or evaluate promptfoo migration |
| Caching one provider's results to isolate another's failures becomes necessary | Add per-scenario result cache to runner |

If migrating to promptfoo: write one `customProvider.js` that shells out to `opencli run`, reuse the existing YAML scenarios with promptfoo's `type: javascript` assertion for file-state checks, and keep `scorer.ts` logic inline in the assertion. The fixture layer is framework-agnostic and survives migration. Note: multi-file scenarios require multiple `assert` blocks (not list-vars) to avoid promptfoo's per-item test expansion.

---

## File change summary

| Action | File |
|---|---|
| Create | `src/eval/runner.ts` |
| Create | `src/eval/scorer.ts` |
| Create | `src/eval/report.ts` |
| Create | `src/eval/config.ts` |
| Create | `src/eval/matrix.test.ts` |
| Create | `src/eval/scorer.test.ts` |
| Create | `src/eval/report.test.ts` |
| Create | `src/eval/config.test.ts` |
| Create | `src/eval/runner.test.ts` |
| Create | `src/eval/scenarios/*.yaml` (20 files) |
| Create | `src/eval/fixtures/mini-ts/` |
| Create | `src/eval/fixtures/mini-ts-bugs/` |
| Create | `src/eval/fixtures/mini-ts-partial/` |
| Create | `src/eval/fixtures/multi-file/` |
| Modify | `package.json` — add `"eval"` script |
| Modify | `src/cli/index.ts` — add `--temperature` flag to `run` command |
| Modify | `src/providers/client.ts` — add `temperature?` to stream options |
| Modify | `src/providers/gemini.ts`, `anthropic.ts`, `openai.ts` — thread temperature |
