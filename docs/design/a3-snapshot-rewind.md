# Design: A3 — Git-snapshot rewind

_Status: Ready for implementation. Tracking issue: [#87](https://github.com/zjshen14/opencli/issues/87). Phase: [Roadmap A3](../roadmap.md)._

---

## Problem and goal

When an agent makes a bad edit — or the user wants to try a different approach — there is no way to undo the agent's file changes short of running `git checkout` manually. This is friction that makes users reluctant to let the agent operate on non-trivial code.

**Goal:** before any write-tool batch, automatically snapshot the current git working tree. `/rewind` in the REPL restores the working tree to the pre-write state in one command.

### What "write tools" means here

Any tool with `readonly: false` — currently `write`, `edit`, `bash` (when it modifies files). The executor already distinguishes read vs write batches; A3 hooks into that existing branch.

### Scope and known limitations

- **Tracked modified files only.** `git stash create` captures tracked files that have been modified. New files created by the agent via the `write` tool on previously-untracked paths are **not** captured in A3. Rationale: adding `--include-untracked` support requires `git stash push` (which modifies the working tree, defeating the purpose) or a separate `git add` step that contaminates the index. This is the correct V1 trade-off; the README documents it.
- **Single-level rewind.** Only the most recent write snapshot is kept. `/rewind` undoes the last write-containing turn, not an arbitrary prior turn. A snapshot stack is deferred.
- **Not a substitute for commits.** A3 is a session-scoped safety net. The existing `/commit` skill handles durable history.
- **Independent of sandbox.** A3 runs regardless of `--sandbox` mode.

---

## Interface contracts

### New file — `src/state/snapshot.ts`

```typescript
export interface RewindResult {
  ok: boolean;
  /** Relative paths of files restored. Empty if nothing was reverted. */
  restoredFiles: string[];
  error?: string;
}

export class SnapshotManager {
  /**
   * Create a git stash object representing the current working tree state.
   * Does NOT modify the working tree (uses `git stash create`, not `git stash push`).
   * Resolves the repo root internally via `git rev-parse --show-toplevel` so
   * capture and rewind are consistent regardless of the caller's cwd.
   * No-op if the working tree is clean or if not inside a git repo.
   * Overwrites any previous snapshot for this session (single-level design).
   */
  async capture(cwd: string): Promise<void>;

  /**
   * Restore the working tree to the state at the last snapshot.
   * Uses `git restore --source <sha> --worktree .` from the repo root —
   * restores the working tree only; the index is NOT touched.
   * Requires git ≥ 2.23 (August 2019).
   * Returns { ok: false } if no snapshot exists or restore fails.
   */
  async rewind(): Promise<RewindResult>;

  /** True if a snapshot has been captured and not yet consumed. */
  get hasSnapshot(): boolean;

  /** True if git is available and the CWD is inside a git repo. Set by first capture(). */
  get gitAvailable(): boolean;

  /**
   * The SHA of the most recently captured stash object.
   * Remains set after a successful rewind — useful for manual recovery
   * if the user wants to re-apply. Undefined before the first capture.
   */
  readonly lastSnapshotSha?: string;
}
```

#### `capture()` — implementation detail

```typescript
async capture(cwd: string): Promise<void> {
  if (this._gitAvailable === false) return;  // permanently disabled this session

  // If OPENCLI_SNAPSHOT=off, skip entirely (matches OPENCLI_SANDBOX=off precedent).
  if (process.env.OPENCLI_SNAPSHOT === "off") return;

  try {
    // Resolve repo root once so all subsequent git operations are repo-root-relative.
    // This prevents partial restores when capture() is called from a subdirectory.
    if (!this.repoRoot) {
      const { stdout } = await execAsync("git rev-parse --show-toplevel", { cwd });
      this.repoRoot = stdout.trim();
      this._gitAvailable = true;
    }

    // git stash create returns the stash commit SHA, or "" if the working tree is clean.
    // Retry once after 50ms on index.lock contention (another git process running).
    let sha = "";
    try {
      const { stdout } = await execAsync("git stash create", { cwd: this.repoRoot });
      sha = stdout.trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("index.lock")) {
        await new Promise(r => setTimeout(r, 50));
        const { stdout } = await execAsync("git stash create", { cwd: this.repoRoot });
        sha = stdout.trim();
      } else {
        throw err;
      }
    }

    if (sha) {
      this.stashSha = sha;
      this._lastSnapshotSha = sha;
    }
    // Empty stdout = clean tree; no snapshot needed.
  } catch {
    // Not a git repo, git not installed, or two consecutive index.lock failures.
    this._gitAvailable = false;
  }
}
```

The stash commit created by `git stash create` is an unreferenced git object (not added to `refs/stash`). It is not visible in `git stash list` and will be garbage-collected ~2 weeks after creation by `git gc --auto`. Within a normal REPL session this is safe.

**`OPENCLI_SNAPSHOT=off`** disables capture entirely — useful on very large repos where `git stash create` over hundreds of dirty files adds noticeable latency per write turn. Document in README alongside `OPENCLI_SANDBOX=off`.

#### `rewind()` — implementation detail

```typescript
async rewind(): Promise<RewindResult> {
  if (!this.stashSha || !this.repoRoot) {
    return { ok: false, restoredFiles: [], error: "No snapshot available for this session." };
  }
  const sha = this.stashSha;
  try {
    // List files that differ between the snapshot and the current working tree.
    // Compute before restoring so we can report what changed.
    const { stdout: diffOut } = await execAsync(
      `git diff --name-only ${sha}`,
      { cwd: this.repoRoot },
    );
    const restoredFiles = diffOut.trim().split("\n").filter(Boolean);

    // git restore --source <sha> --worktree restores the WORKING TREE only.
    // The index is left untouched, so any unrelated staged changes the user had
    // before the agent ran are preserved.
    // Requires git ≥ 2.23. The full-repo pathspec "." from repoRoot covers all files.
    await execAsync(`git restore --source ${sha} --worktree .`, { cwd: this.repoRoot });

    this.stashSha = undefined;  // consumed; _lastSnapshotSha intentionally kept for diagnostics
    return { ok: true, restoredFiles };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // stashSha left set — user can retry or recover manually using lastSnapshotSha
    return { ok: false, restoredFiles: [], error: message };
  }
}
```

**Why `git restore --source <sha> --worktree` rather than `git stash apply`:**
`git stash apply` replays the stash as a patch on top of the current working tree and can fail with conflicts if the tree has diverged. `git restore --source <sha> --worktree` directly sets file contents to the snapshot state with no conflict-detection pass, which is simpler and more predictable for a "rewind" command. Crucially, `--worktree` leaves the index untouched — any unrelated staged changes the user had before running the agent are preserved.

**Why not `git checkout <sha> -- .`:**
`git checkout <tree-ish> -- <paths>` updates both the working tree AND the index. A user with staged changes unrelated to what the agent touched would lose their staged state silently. `git restore --worktree` makes the index-vs-worktree split explicit. `git restore` requires git ≥ 2.23 (August 2019) — document in README.

### Extension to `ExecutorDeps` — `src/core/executor.ts`

```typescript
export interface ExecutorDeps {
  tools: ToolRegistry;
  skills: SkillRegistry;
  context: ContextManager;
  tmpDir?: string;
  readOnly?: boolean;
  confirmFn?: ConfirmFn;
  obs?: ObservabilityHandler;
  snapshot?: SnapshotManager;   // NEW — optional; A3 is off if absent
  cwd?: string;                 // NEW — passed to snapshot.capture(); defaults to process.cwd()
}
```

In `executeCalls()`, before the sequential write-tool dispatch:

```typescript
if (toolCalls.some((c) => !deps.tools.get(c.name)?.readonly)) {
  // Snapshot before any writes — capture is idempotent on clean trees.
  await deps.snapshot?.capture(deps.cwd ?? process.cwd());

  results = [];
  for (const call of toolCalls) {
    results.push(await executeOneCall(call, deps));
  }
}
```

Capture is awaited so a snapshot failure can be logged before writes proceed — but a capture failure never blocks execution (the `SnapshotManager.capture()` method swallows errors internally).

### Slash command — `src/cli/repl.ts`

Add `/rewind` to the built-in slash command list:

```typescript
{ name: "rewind", description: "undo agent file changes since last snapshot" },
```

Handler:

```typescript
if (input === "/rewind") {
  // Three distinct states require three distinct messages.
  if (!snapshotManager.gitAvailable) {
    printInfo("Rewind unavailable: not in a git repo, or git not installed.");
    continue;
  }
  if (!snapshotManager.hasSnapshot) {
    printInfo("No snapshot — no writes have happened this session.");
    continue;
  }
  const result = await snapshotManager.rewind();
  if (result.ok) {
    if (result.restoredFiles.length === 0) {
      printInfo("Working tree already matches snapshot — nothing to restore.");
    } else {
      printInfo(`Rewound ${result.restoredFiles.length} file(s):`);
      for (const f of result.restoredFiles) printInfo(`  ${f}`);
    }
  } else {
    printError(`Rewind failed: ${result.error}`);
    printError(`To recover manually: git restore --source ${snapshotManager.lastSnapshotSha} --worktree .`);
  }
  continue;
}
```

### Wiring in `src/cli/index.ts` and `src/core/agent.ts`

`SnapshotManager` is passed through the existing `Agent` constructor options bag — the same pattern used by `onObservability` and `model`. A new setter (`setSnapshotManager`) would introduce temporal coupling (under-configured agent between construction and the setter call) with no benefit.

```typescript
// cli/index.ts
const snapshotManager = new SnapshotManager();

const agent = new Agent(client, registry, skills, systemInstruction, config.historySize, maxTurns, {
  model: config.model,
  onObservability: obs,
  snapshotManager,          // NEW optional field
});
```

`Agent` stores it and passes it through to `ExecutorDeps`:

```typescript
// core/agent.ts — constructor options bag
options?: {
  model?: string;
  onObservability?: ObservabilityHandler;
  snapshotManager?: SnapshotManager;   // NEW
}
```

```typescript
// core/agent.ts — inside the run loop, after first write turn
if (this.snapshotManager && !this.snapshotManager.gitAvailable) {
  // gitAvailable transitions false after the first failed capture.
  // Emit the warning exactly once via the CLI layer.
}

const { results } = await executeCalls(pendingCalls, {
  ...existingDeps,
  snapshot: this.snapshotManager,
  cwd: process.cwd(),
});
```

The REPL receives the same `snapshotManager` reference (passed as a constructor arg to `runRepl`) so `/rewind` calls it directly. The one-time "git unavailable" warning is emitted by the CLI layer by checking `snapshotManager.gitAvailable` after each agent turn that included writes.

---

## Data flow

### Capture sequence (per agent turn with writes)

```
Agent loop calls executeCalls()
  → toolCalls.some(write) = true
  → await snapshotManager.capture(cwd)
      → git stash create
      → stores SHA (or no-op if clean tree)
  → execute write tools sequentially
  → return results
```

### Rewind sequence

```
User types /rewind in REPL
  → snapshotManager.gitAvailable = true
  → snapshotManager.hasSnapshot = true
  → snapshotManager.rewind()
      → saves sha locally before clearing this.stashSha
      → git restore --source <sha> --worktree .  (from repoRoot; index untouched)
      → clears this.stashSha; _lastSnapshotSha kept for diagnostics
      → returns { ok: true, restoredFiles: [...] }
  → REPL prints restored file list
```

---

## Failure modes

| Failure | Behaviour |
|---|---|
| Not a git repo | `capture()` sets `gitAvailable = false`; executor proceeds without snapshot; REPL shows "not in a git repo" on `/rewind` |
| Git not installed | Same as above |
| `OPENCLI_SNAPSHOT=off` | `capture()` is a no-op; `gitAvailable` stays `true` (git may be present); REPL shows "No snapshot" on `/rewind` |
| Clean working tree | `git stash create` returns `""`; no SHA stored; no-op; `hasSnapshot` stays false |
| OpenCLI run from a subdirectory | `repoRoot` resolved at first `capture()` via `git rev-parse --show-toplevel`; all git ops use `repoRoot`; rewind covers the entire repo, not just the subdir |
| `git restore` fails (permissions, corrupted object) | Returns `{ ok: false, error: "..." }`; `stashSha` left set; `lastSnapshotSha` available for manual recovery hint |
| Unrelated staged changes before agent run | `git restore --worktree` leaves the index untouched — staged changes survive the rewind |
| Write tool creates a new (untracked) file | File is not in the snapshot; `/rewind` does not remove it. Documented limitation — user must `rm` manually |
| User runs `/rewind` twice | Second call: `hasSnapshot = false` → "No snapshot" message |
| Agent makes writes in two consecutive turns | Second `capture()` overwrites the first SHA — only the pre-second-turn state is snapshotable. Single-level design is explicit. |
| Concurrent `.git/index.lock` (another git process) | Single retry after 50ms. If retry also fails, `gitAvailable = false` for the session — transient failure becomes permanent disable. Acceptable for V1; uncommon in practice. |

---

## Migration plan

All changes are additive. `ExecutorDeps.snapshot` is optional; callers that don't set it (e.g. tests using `executeCalls` directly) are unaffected.

The one existing call site that constructs `ExecutorDeps` is in `agent.ts`. It gains two new fields (`snapshot`, `cwd`) only if the caller wired up a `SnapshotManager`.

No changes to tool definitions, the skill system, or provider clients.

---

## Test strategy

| Test | File | What it proves |
|---|---|---|
| `capture()`: clean tree → no SHA stored, `hasSnapshot = false` | `state/snapshot.test.ts` | No-op on clean tree |
| `capture()`: dirty tree → SHA stored, `hasSnapshot = true` | same | Happy path |
| `capture()`: not a git repo → `gitAvailable = false` | same | Graceful failure |
| `capture()`: run from subdirectory → `repoRoot` set to repo root | same | Subdirectory cwd fix |
| `capture()`: `OPENCLI_SNAPSHOT=off` → no-op, `gitAvailable` unset | same | Env var escape hatch |
| `rewind()`: no snapshot → `{ ok: false }` | same | Guard against premature rewind |
| `rewind()`: restores tracked modified file in same dir | same | Core behaviour |
| `rewind()`: **run from subdirectory; write was in sibling dir → sibling dir restored** | same | Repo-root pathspec correctness (drives fix #2) |
| `rewind()`: pre-existing staged hunk survives rewind (index untouched) | same | `--worktree` only (drives fix #1) |
| `rewind()`: `lastSnapshotSha` remains set after successful rewind | same | SHA lifecycle |
| `rewind()`: second call → `hasSnapshot = false`, returns "no snapshot" | same | Double-rewind guard |
| `executeCalls()`: write batch triggers `capture()` | `core/executor.test.ts` (add) | Executor hook fires |
| `executeCalls()`: read-only batch does NOT trigger `capture()` | same | No spurious snapshots |
| `executeCalls()`: `snapshot` absent → no error | same | Optional wiring safe |
| `/rewind` REPL: `gitAvailable = false` → distinct "not in a git repo" message | `cli/repl.test.ts` (add) | Three-state messages (drives fix #4) |
| `/rewind` REPL: `hasSnapshot = false` → "no writes" message | same | Guard message |
| `/rewind` REPL: success → file list printed | same | User-facing output |
| `/rewind` REPL: failure → SHA printed for manual recovery | same | Error guidance |

Tests use a real temporary git repo (created in `beforeEach` with `git init && git add . && git commit`). No mocking of git — the behaviour being tested is git interaction. The subdirectory test creates a nested dir, `cd`s into it, calls `capture()`, modifies a file in the parent, then calls `rewind()` and asserts the parent file was restored.

---

## Open questions

**Q1 — One-time git-unavailability warning: where to emit it? _(answered)_**
`SnapshotManager` exposes `gitAvailable: boolean` (set by the first `capture()` call). The CLI layer checks it after each write-containing agent turn and emits the warning exactly once. Same pattern as `SandboxRunner.warning` from A1 — no I/O in the library layer.

**Q2 — Should `/rewind` be available in `--yes` / non-interactive mode? _(answered)_**
No change needed. In non-interactive mode there is no REPL, so `/rewind` is unreachable. The snapshot is taken as a no-cost safety net and the stash object is GC'd by git eventually.

---

## File change summary

| Action | File |
|---|---|
| Create | `src/state/snapshot.ts` |
| Create | `src/state/snapshot.test.ts` |
| Modify | `src/core/executor.ts` — add `snapshot?` and `cwd?` to `ExecutorDeps`; call `capture()` before write batch |
| Modify | `src/core/executor.test.ts` — add snapshot hook tests |
| Modify | `src/core/agent.ts` — add `snapshotManager?` to constructor options bag; thread snapshot + cwd into `ExecutorDeps`; emit gitAvailable warning to CLI layer |
| Modify | `src/cli/repl.ts` — add `/rewind` to command list and three-state handler; accept `snapshotManager` param |
| Modify | `src/cli/index.ts` — create `SnapshotManager`; pass via Agent options bag and to `runRepl` |
| Update | `README.md` — document `/rewind`, `OPENCLI_SNAPSHOT=off`, known limitation (untracked files), minimum git 2.23 |
