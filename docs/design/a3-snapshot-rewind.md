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
   * No-op if the working tree is clean or if not inside a git repo.
   * Overwrites any previous snapshot for this session (single-level design).
   */
  async capture(cwd: string): Promise<void>;

  /**
   * Restore the working tree to the state at the last snapshot.
   * Uses `git stash apply <hash>` — leaves the stash object intact.
   * Returns { ok: false } if no snapshot exists or apply fails.
   */
  async rewind(cwd: string): Promise<RewindResult>;

  /** True if a snapshot has been captured this session. */
  get hasSnapshot(): boolean;
}
```

#### `capture()` — implementation detail

```typescript
async capture(cwd: string): Promise<void> {
  try {
    // git stash create returns the stash commit SHA, or "" if the working tree is clean.
    const { stdout } = await execAsync("git stash create", { cwd });
    const sha = stdout.trim();
    if (sha) {
      this.stashSha = sha;
    }
    // Empty stdout means clean tree — no snapshot needed, leave this.stashSha unchanged.
  } catch {
    // Not a git repo, git not installed, etc. — disable silently.
    // The caller emits a one-time warning if this.gitAvailable becomes false.
    this.gitAvailable = false;
  }
}
```

The stash commit created by `git stash create` is an unreferenced git object (not added to `refs/stash`). It is not visible in `git stash list` and will be garbage-collected ~2 weeks after creation by `git gc --auto`. Within a normal REPL session this is safe; the object is only needed until the user either accepts the changes or runs `/rewind`.

#### `rewind()` — implementation detail

```typescript
async rewind(cwd: string): Promise<RewindResult> {
  if (!this.stashSha) {
    return { ok: false, restoredFiles: [], error: "No snapshot available for this session." };
  }
  try {
    // List files that differ between stash and current working tree.
    const { stdout: diffOut } = await execAsync(
      `git diff --name-only ${this.stashSha}`,
      { cwd },
    );
    const restoredFiles = diffOut.trim().split("\n").filter(Boolean);

    // Apply the stash (restores tracked modified files).
    // --index preserves staged/unstaged split; omit it to keep behaviour simple.
    await execAsync(`git checkout ${this.stashSha} -- .`, { cwd });

    this.stashSha = undefined;  // consumed
    return { ok: true, restoredFiles };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, restoredFiles: [], error: message };
  }
}
```

**Why `git checkout <sha> -- .` rather than `git stash apply <sha>`:**
`git stash apply` replays the stash as a patch on top of the current working tree, which can fail with conflicts if the tree has diverged from the stash base. `git checkout <sha> -- .` directly restores all tracked files to the stash's tree state regardless of the current diff, which is simpler and more predictable. The trade-off is that it is more aggressive (it also resets any changes the user made manually since the snapshot), but that is the expected behaviour for a "rewind" command.

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
  if (!snapshotManager.hasSnapshot) {
    printInfo("No snapshot available — no writes have happened this session.");
    continue;
  }
  const result = await snapshotManager.rewind(process.cwd());
  if (result.ok) {
    if (result.restoredFiles.length === 0) {
      printInfo("Working tree already matches snapshot — nothing to restore.");
    } else {
      printInfo(`Rewound ${result.restoredFiles.length} file(s):`);
      for (const f of result.restoredFiles) printInfo(`  ${f}`);
    }
  } else {
    printError(`Rewind failed: ${result.error}`);
    printError("You can recover manually with: git checkout <sha> -- .");
    printError(`Snapshot SHA: ${snapshotManager.lastSnapshotSha ?? "(none)"}`);
  }
  continue;
}
```

### Wiring in `src/cli/index.ts` and `src/core/agent.ts`

The `SnapshotManager` instance is created in `cli/index.ts` alongside the other session-scoped objects (runner, manager) and passed into `Agent` via a new optional setter:

```typescript
// cli/index.ts
const snapshotManager = new SnapshotManager();
agent.setSnapshotManager(snapshotManager);

// Emit one-time warning if git is not available, after first write attempt.
// The manager sets this.gitAvailable = false on the first failed capture.
```

`Agent` passes it through to `ExecutorDeps`:

```typescript
// core/agent.ts  (inside the runloop)
const { results } = await executeCalls(pendingCalls, {
  ...existingDeps,
  snapshot: this.snapshotManager,
  cwd: process.cwd(),
});
```

The REPL receives the same `snapshotManager` reference so `/rewind` calls it directly.

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
  → snapshotManager.hasSnapshot = true
  → snapshotManager.rewind(cwd)
      → git checkout <sha> -- .
      → clears this.stashSha
      → returns { ok: true, restoredFiles: [...] }
  → REPL prints restored file list
```

---

## Failure modes

| Failure | Behaviour |
|---|---|
| Not a git repo | `capture()` sets `gitAvailable = false`; executor proceeds without snapshot; REPL emits one-time warning on first `/rewind` attempt |
| Git not installed | Same as above |
| Clean working tree | `git stash create` returns `""`; no SHA stored; no-op |
| `git checkout` conflict on rewind | Returns `{ ok: false, error: "..." }`; prints the SHA so user can recover manually |
| Write tool creates a new (untracked) file | File is not in the snapshot; `/rewind` does not remove it. Documented limitation — user must `rm` manually |
| User runs `/rewind` twice | Second call: `hasSnapshot = false` → "No snapshot available" message |
| Agent makes writes in two consecutive turns | Second capture overwrites the first SHA — only the pre-second-turn state is snapshotable. Single-level design is explicit. |

---

## Migration plan

All changes are additive. `ExecutorDeps.snapshot` is optional; callers that don't set it (e.g. tests using `executeCalls` directly) are unaffected.

The one existing call site that constructs `ExecutorDeps` is in `agent.ts`. It gains two new fields (`snapshot`, `cwd`) only if the caller wired up a `SnapshotManager`.

No changes to tool definitions, the skill system, or provider clients.

---

## Test strategy

| Test | File | What it proves |
|---|---|---|
| `capture()`: clean tree → no SHA stored | `state/snapshot.test.ts` | No-op on clean tree |
| `capture()`: dirty tree → SHA stored | same | Happy path |
| `capture()`: not a git repo → `gitAvailable = false` | same | Graceful failure |
| `rewind()`: no snapshot → `{ ok: false }` | same | Guard against premature rewind |
| `rewind()`: restores tracked modified file | same | Core behaviour |
| `rewind()`: clears SHA after use | same | Single-use semantics |
| `rewind()`: second call returns "no snapshot" | same | Double-rewind guard |
| `executeCalls()`: write batch triggers `capture()` | `core/executor.test.ts` (add) | Executor hook fires |
| `executeCalls()`: read-only batch does NOT trigger `capture()` | same | No spurious snapshots |
| `executeCalls()`: `snapshot` absent → no error | same | Optional wiring safe |
| `/rewind` REPL command: output on success | `cli/repl.test.ts` (add) | User-facing message |
| `/rewind` REPL command: output when no snapshot | same | Guard message |

Tests use a real temporary git repo (created in `beforeEach` with `git init`). No mocking of git — the behaviour being tested is git interaction.

---

## Open questions

**Q1 — One-time git-unavailability warning: where to emit it?**
The `SnapshotManager` lives in the library layer (`src/state/`) which should not write to `process.stderr` directly. Options: (a) add a `warning: string | null` field to `SnapshotManager` that the CLI layer reads after each capture and emits once; (b) accept a `warnFn` callback in the constructor.
_Recommendation: option (a) — same pattern as `SandboxRunner.warning` from A1. Consistent, testable, no I/O in the library layer._

**Q2 — Should `/rewind` be available in `--yes` / non-interactive mode?**
In non-interactive mode (CI, scripts), the user has no REPL to type `/rewind`. The snapshot is still taken, but it's never consumed. This is harmless — the stash SHA is garbage-collected by git eventually.
_Recommendation: no change needed. The snapshot is a no-cost safety net; if it's never used, the only overhead is one `git stash create` call per write turn._

---

## File change summary

| Action | File |
|---|---|
| Create | `src/state/snapshot.ts` |
| Create | `src/state/snapshot.test.ts` |
| Modify | `src/core/executor.ts` — add `snapshot?` and `cwd?` to `ExecutorDeps`; call `capture()` before write batch |
| Modify | `src/core/executor.test.ts` — add snapshot hook tests |
| Modify | `src/core/agent.ts` — add `setSnapshotManager()`; thread snapshot + cwd into `ExecutorDeps` |
| Modify | `src/cli/repl.ts` — add `/rewind` to command list and handler |
| Modify | `src/cli/index.ts` — create `SnapshotManager`; call `agent.setSnapshotManager()`; pass to REPL |
| Update | `README.md` — document `/rewind` command and known limitation (untracked files) |
