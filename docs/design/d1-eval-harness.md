# Design: D1 — Scenario suite + cross-provider parity matrix

_Status: Ready for implementation. Tracking issue: [#90](https://github.com/zjshen14/opencli/issues/90). Phase: [Roadmap D1](../roadmap.md#phase-d--evaluation)._

---

## Goal

A fast evaluation loop that runs 20 hand-written scenarios against all configured providers, produces a parity matrix, and catches regressions before B-phase work ships. This establishes the baseline required by the roadmap's sequencing rule: **D1 before Phase B starts.**

`npm run eval` is the entry point. It makes real API calls and costs money (~$1–5 per full run). It is intentionally separate from `npm test`, which is fully offline.

---

## File layout

```
src/eval/
  runner.ts          # runScenario(scenario, model, opts?) → RunResult
  scorer.ts          # scoreScenario(scenario, result) → ScoreResult
  report.ts          # formatMatrix(results) → markdown table string
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
      contains?: string       # substring required in file
      notContains?: string    # substring that must be absent
      exists?: boolean        # file must exist (default true if key is present)
```

All string comparisons are case-sensitive. `contains` matches anywhere in the file.

---

## Scoring

```
pass    — all expected criteria satisfied
partial — ≥ 50 % of expected.files checks pass (multi-file tasks only)
fail    — timeout, non-zero exit, no outputKeywords matched, or < 50 % file checks
```

`scoreScenario` returns `{ score: "pass" | "partial" | "fail", reason: string }`.

---

## Runner

### Binary resolution

```typescript
const DIST_ENTRY = resolve(new URL(".", import.meta.url).pathname, "../../../dist/index.js");
```

Same pattern as `src/cli/run.smoke.test.ts`. Tests are skipped (`it.skip`) when the binary does not exist — add a top-level note: "Run `npm run build` first."

### `runScenario` steps

1. Create temp dir: `mkdtemp(join(tmpdir(), "opencli-eval-"))`
2. Copy fixture: `cp -r src/eval/fixtures/<fixture>/ <tmpdir>/`
3. `git init && git add . && git commit -m "fixture"` (so snapshot/rewind are git-aware)
4. Spawn: `node <DIST_ENTRY> run "<prompt>" --model <model> --yes --max-turns 20 --sandbox off`
   - `cwd`: temp dir
   - `env`: `{ ...process.env }` (inherits API keys)
   - Timeout: 120 s via `AbortController`
5. Capture combined stdout as `output: string`
6. After process exits, read final FS state for all paths mentioned in `expected.files`
7. `rm -rf` temp dir
8. Return `RunResult`

```typescript
export interface RunResult {
  output: string;         // full stdout from the agent run
  files: Record<string, string | null>; // path → content (null = does not exist)
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}
```

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
  return providers;
}
```

Provider models are overridable via env vars to allow testing with different tiers without changing code. Defaults are the cheapest capable models for each provider.

---

## Matrix test

```typescript
// src/eval/matrix.test.ts
import { describe, it, expect } from "vitest";
import { configuredProviders } from "./config.js";
import { loadScenarios } from "./scenarios.js";
import { runScenario } from "./runner.js";
import { scoreScenario } from "./scorer.js";
import { formatMatrix } from "./report.js";

const providers = configuredProviders();
const scenarios = await loadScenarios();

// Accumulate results for the summary matrix printed after all tests.
const matrix: Record<string, Record<string, string>> = {};

describe.each(providers)("provider: $label ($model)", ({ label, model }) => {
  describe.each(scenarios)("$id", (scenario) => {
    it(scenario.description, { timeout: 130_000 }, async () => {
      const result = await runScenario(scenario, model);
      const { score, reason } = scoreScenario(scenario, result);
      matrix[scenario.id] ??= {};
      matrix[scenario.id][label] = score;
      // partial is a soft pass in the matrix; hard fail is a test failure
      if (score === "fail") {
        console.log(`[${label}] ${scenario.id} FAIL: ${reason}`);
      }
      expect(score, reason).not.toBe("fail");
    });
  });
});

afterAll(() => {
  if (Object.keys(matrix).length > 0) {
    console.log("\n" + formatMatrix(matrix, providers.map((p) => p.label)));
  }
});
```

A single `fail` causes the test to fail. `partial` is a soft pass (no assertion failure) — it is visible in the matrix output. The matrix is printed to stdout at the end for CI summary capture.

---

## Parity warning

`formatMatrix` computes per-provider pass rates and appends a warning line if any provider drops more than 15 percentage points below the leading provider:

```
⚠  gemini pass rate (75%) is 20pp below leading provider (anthropic 95%)
```

This is a console warning only — it does not fail the test suite. The purpose is visibility, not a gate.

---

## `npm run eval` script

Add to `package.json`:
```json
"eval": "vitest run src/eval/matrix.test.ts --reporter=verbose"
```

This runs only the eval matrix, not the full test suite.

---

## Fixtures

### `mini-ts/` — clean project (used by read-explain and feature-add)

```
src/
  math.ts     — exports add(a, b), subtract(a, b), multiply(a, b)
  utils.ts    — exports clamp(v, lo, hi), isEven(n), sum(arr), capitalize(s)
  counter.ts  — exports Counter class: increment(), decrement(), reset(), value getter
  task.ts     — exports Task interface { id, title, done }, createTask(title) factory
tsconfig.json
package.json  — name: "mini-ts", type: "module", no dependencies
```

### `mini-ts-bugs/` — same project with deliberate defects

Defects are isolated to one file per bug scenario:

| Defect | File | What's wrong |
|---|---|---|
| off-by-one | `counter.ts` | `get value() { return this._count - 1; }` |
| null-deref | `utils.ts` | `sum([])` throws because of missing empty-array guard |
| wrong-operator | `math.ts` | `subtract(a, b)` returns `a + b` instead of `a - b` |
| missing-return | `task.ts` | `createTask()` branch doesn't return on invalid input (falls off) |
| string-coerce | `utils.ts` | `capitalize` uses `==` instead of `===` for empty-string check |

Each bug scenario specifies which single file to check. The runner copies the full project, so the agent has all context.

### `mini-ts-partial/` — project with intentional gaps (feature-add and refactor)

| Gap | File | What's missing |
|---|---|---|
| no-clamp | `math.ts` | `clamp()` function absent |
| no-power | `math.ts` | `power(base, exp)` function absent |
| no-validation | `math.ts` | `add()` lacks type guard for non-number inputs |
| no-version | `utils.ts` | No `VERSION` constant exported |
| verbose-duplicate | `utils.ts` | Two identical validation blocks inline (not extracted) |
| long-fn | `task.ts` | `processTask()` is one 40-line function to be split |
| bad-varname | `counter.ts` | Internal state stored in `x` instead of `count` |

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
description: Fix Counter.value getter returning count - 1
prompt: "There is a bug in src/counter.ts: the value getter returns one less than expected. Fix it."
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
prompt: "The subtract function in src/math.ts returns the wrong result. Fix it."
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
      contains: "0"
```

```yaml
id: fix-missing-return
category: bug-fix
description: Fix createTask() branch that falls off without returning
prompt: "createTask() in src/task.ts has a branch that doesn't return anything for invalid input. Fix it to return null."
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
prompt: "capitalize() in src/utils.ts has a loose equality comparison that can cause incorrect results. Fix it."
fixture: mini-ts-bugs
expected:
  files:
    src/utils.ts:
      contains: "==="
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
      contains: "TypeError"
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
      contains: "VERSION"
      contains: "'1.0.0'"
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
description: Extract repeated validation blocks into a helper
prompt: "src/utils.ts has two identical validation blocks. Extract the duplicated logic into a named helper function and call it from both places."
fixture: mini-ts-partial
expected:
  files:
    src/utils.ts:
      contains: "function"
```

```yaml
id: rename-internal-variable
category: refactor
description: Rename x to count in counter.ts
prompt: "The internal state in src/counter.ts is stored in a variable named 'x'. Rename it to 'count' throughout the file."
fixture: mini-ts-partial
expected:
  files:
    src/counter.ts:
      contains: "count"
      notContains: "this.x"
```

```yaml
id: split-long-function
category: refactor
description: Split processTask() into validate + execute
prompt: "processTask() in src/task.ts is too long. Split it into validateTask() and executeTask(), and have processTask() call both in sequence."
fixture: mini-ts-partial
expected:
  files:
    src/task.ts:
      contains: "validateTask"
      contains: "executeTask"
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
      contains: "add"
      contains: "subtract"
      contains: "multiply"
```

```yaml
id: create-and-wire-formatter
category: multi-file
description: Create formatter.ts and import it from utils.ts
prompt: "Create src/formatter.ts with a format(value: number): string function that formats numbers with two decimal places. Then import and use it in src/utils.ts."
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
prompt: "Add a 'description: string' field to the Task interface in src/task.ts. Update createTask() in src/task.impl.ts to accept and set it."
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

### Fixture copy

Use `cp -r` via `execAsync` for simplicity. No `fs.cp` — Node 16 compat is not needed but keeping it simple avoids edge cases.

### `--max-turns 20`

Caps cost on runaway agents. For simple scenarios, completion happens in 2–5 turns. 20 is generous.

### Skipping when binary not built

```typescript
const CLI_BUILT = existsSync(DIST_ENTRY);
if (!CLI_BUILT) {
  it.skip("dist/index.js not found — run `npm run build` first");
}
```

Matches the pattern in `run.smoke.test.ts`.

### `contains` with multiple values

A scenario may have multiple `contains` assertions on one file (see `add-math-tests`). The YAML schema should allow `contains` to be either a `string` or `string[]`. The scorer checks all entries with AND semantics.

---

## Test strategy for the harness itself

The harness components (`runner.ts`, `scorer.ts`, `report.ts`) are tested offline — no real API calls needed:

| Test | File | What it proves |
|---|---|---|
| `scoreScenario` pass: all keywords present | `scorer.test.ts` | Keyword match |
| `scoreScenario` fail: keyword missing | same | Miss detection |
| `scoreScenario` pass: file contains expected string | same | File match |
| `scoreScenario` partial: 1/2 files match | same | Partial scoring |
| `formatMatrix` renders correct column widths | `report.test.ts` | Table output |
| `formatMatrix` emits 15pp warning when threshold breached | same | Parity alert |
| `configuredProviders` returns only providers with keys set | `config.test.ts` | Env var detection |
| `runScenario` copies fixture and produces RunResult | `runner.test.ts` | Integration (uses a mock `opencli` script that exits 0 immediately) |

These live in `src/eval/*.test.ts` and run as part of `npm test` (no API calls).

---

## CI integration

| Command | When | Cost |
|---|---|---|
| `npm test` | Every PR (automated) | Free — harness unit tests only |
| `npm run eval` | Manual trigger on PRs; auto on release branch | ~$1–5 per full run |

The parity matrix output is captured in CI as a job summary annotation.

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
