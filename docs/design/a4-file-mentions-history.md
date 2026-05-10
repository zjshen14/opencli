# Design: A4 — @file mention expansion + per-CWD input history

_Status: Ready for implementation. Tracking issue: [#88](https://github.com/zjshen14/opencli/issues/88). Phase: [Roadmap A4](../roadmap.md)._

---

## Problem and goal

Two gaps in the current input handling:

1. **No @file shorthand.** To include file content in a prompt, the user must either ask the agent to read it (one extra tool round-trip) or paste content manually. `@src/core/agent.ts` should expand to the file's contents inline before the message reaches the agent.

2. **History is global, not per-CWD.** The existing `~/.opencli/history` file is a single global history shared across all projects. History entries from an unrelated project pollute the up-arrow list. Per-CWD history makes the REPL context-aware.

**Goal:** resolve `@path` tokens in user input before they reach `Agent.run()`; and scope input history to the current working directory.

---

## Scope

| Item | Status |
|---|---|
| `@path` single-file expansion | New |
| `@glob` multi-file expansion | New |
| Per-CWD history file | Change (global → per-CWD) |
| `historySize` for input history | Out of scope — `historySize` controls conversation context messages, not REPL input lines; input history capped separately at 500 entries |

---

## Part 1 — @file mention expansion

### Where it lives

New file: **`src/cli/mentions.ts`**

The expansion is a pre-processing step on raw user input — a CLI-layer responsibility. It never belongs in `core/` (the agent core should not touch the filesystem directly; that is the tools' job). The CLI layer passes the already-expanded string to `Agent.run()`.

### Detection

```
/@(\S+)/g
```

Match `@` followed by any non-whitespace run. The token after `@` is the candidate path or glob pattern.

Heuristics are intentionally absent — the function tries to resolve every token as a filesystem path. If it resolves, it expands. If it does not, a warning is printed and the original `@token` is left unchanged in the message. This handles `@username`, `@TODO`, and other non-path uses gracefully without a deny-list.

### Glob detection

A token is treated as a glob pattern if it contains `*`, `?`, `{`, or `[`. Otherwise it is treated as a plain path.

### Expansion format

Each expanded file is replaced inline at the `@token` position:

```
--- @src/core/agent.ts ---
import type { LLMClient } from "../providers/client.js";
...
--- end ---
```

For a glob expansion that matches multiple files, the replacement is the concatenation of all per-file blocks, separated by a blank line.

The header/footer makes file boundaries explicit to the LLM.

### Size caps

| Limit | Value | Rationale |
|---|---|---|
| Single file | 50 000 chars | Large files can be read with the `read` tool (offset/limit); @file is for quick context injection |
| Glob: max file count | 20 files | Prevent accidental `@**/*` blowing up token budget |
| Glob: total chars | 200 000 chars | Hard stop across all files in a glob expansion |

When a file exceeds the single-file cap, the content is truncated and a note is appended:
```
--- @src/large-file.ts (truncated at 50 000 chars) ---
...
--- end ---
```

When a glob expansion hits the file-count or total-char cap, expansion stops at the cap and a warning is printed to stderr: `@src/**/*.ts: expansion capped at 20 files`.

### Binary files

Skip binary files silently (detect via the `\0` byte heuristic: if the first 8 000 bytes contain a null byte, treat as binary). Emit a warning: `@path/to/binary: skipped (binary file)`.

### Interface

```typescript
// src/cli/mentions.ts

export interface ExpandResult {
  /** The input string with @tokens replaced by file content blocks. */
  expanded: string;
  /** Non-fatal warnings to print before the agent turn (e.g. missing files, caps hit). */
  warnings: string[];
}

/**
 * Resolve @path and @glob tokens in `input` against `cwd`.
 * Tokens that do not resolve to readable files are left unchanged and
 * reported in `warnings`. Never throws.
 */
export async function expandMentions(input: string, cwd: string): Promise<ExpandResult>;
```

### Glob implementation

Reuse the same `walk()` + `matchGlob()` logic from `src/tools/file/glob.ts`. Because those functions are not exported, **duplicate** them in `mentions.ts` — they are 25 lines of pure Node.js and the duplication avoids coupling CLI to tool internals. If a third caller emerges, extract to a shared utility then.

### Wiring — `src/cli/repl.ts`

```typescript
// After readLine() returns user input, before passing to Agent.run():
const { expanded, warnings } = await expandMentions(raw, process.cwd());
for (const w of warnings) printInfo(w);
const input = expanded;
```

The expand call is unconditional — if there are no `@` tokens the function is a fast no-op (regex finds nothing).

---

## Part 2 — Per-CWD input history

### Current state

`src/cli/input.ts` persists history to a single file: `~/.opencli/history` (defined as `HISTORY_FILE = join(AGENT_DIR, "history")`). This is loaded and saved in `repl.ts` via `loadHistory()` / `saveHistory()`.

### Target

History stored per-CWD at `~/.opencli/history/<base64url-encoded-cwd>`, using the same encoding as session logs (`Buffer.from(cwd).toString("base64url")`).

### Changes to `src/cli/input.ts`

```typescript
// Before:
const HISTORY_FILE = join(AGENT_DIR, "history");

export async function loadHistory(): Promise<string[]> { ... }
export async function saveHistory(history: string[]): Promise<void> { ... }
```

```typescript
// After: accept cwd, derive per-project path
function historyFile(cwd: string): string {
  return join(AGENT_DIR, "history", Buffer.from(cwd).toString("base64url"));
}

export async function loadHistory(cwd: string): Promise<string[]> {
  // reads from historyFile(cwd)
}

export async function saveHistory(history: string[], cwd: string): Promise<void> {
  // writes to historyFile(cwd), creates dir if needed
  await mkdir(join(AGENT_DIR, "history"), { recursive: true });
  ...
}
```

### Changes to `src/cli/repl.ts`

Pass `process.cwd()` to both calls:

```typescript
const history = await loadHistory(process.cwd());
// ...
await saveHistory(history, process.cwd());
```

### Migration

Old global `~/.opencli/history` file is left in place — no migration step. On first run in a given directory the history starts fresh. Old entries are not lost (still readable by any manual inspection) but are no longer loaded. This is intentional: mixing old global history into per-CWD history would pollute it with unrelated entries.

### `MAX_HISTORY` cap

Keep the existing `MAX_HISTORY = 500` hardcoded constant. Input history is short-lived UX state — a 500-line cap is sufficient for all realistic use cases. `historySize` remains exclusively the conversation-messages cap and is not reused here.

---

## Failure modes

| Failure | Behaviour |
|---|---|
| `@nonexistent.ts` | Warn: `@nonexistent.ts: file not found`; token left in message |
| `@src/**/*.ts` matches 0 files | Warn: `@src/**/*.ts: no files matched`; token left in message |
| File read error (permissions) | Warn: `@path: <error message>`; token left in message |
| Binary file | Warn: `@path: skipped (binary file)`; token left in message |
| File exceeds 50 000-char cap | Content truncated; note appended inline |
| Glob hits file-count/char cap | Expansion stops at cap; warning printed to stderr |
| History file unreadable | `loadHistory()` returns `[]`; non-fatal |
| History write fails | `saveHistory()` swallows the error; non-fatal |
| History dir does not exist | `saveHistory()` creates it with `mkdir({ recursive: true })` |

---

## Test strategy

### `src/cli/mentions.test.ts` (new)

| Test | What it proves |
|---|---|
| Single `@file.ts` → content block inline | Core expansion |
| `@nonexistent.ts` → warning, token unchanged | Missing-file handling |
| `@src/**/*.ts` glob → multiple file blocks | Glob expansion |
| `@src/**/*.ts` matches 0 files → warning | Empty glob |
| File exceeds 50 000-char cap → truncated with note | Size cap |
| Glob hits 20-file cap → warns, partial result | File-count cap |
| Binary file → warning, skipped | Binary detection |
| Input with no `@` tokens → unchanged, no warnings | Fast path |
| `@token` in middle of sentence → expanded inline | Inline replacement |

Use a real temp directory (no mocking of fs).

### `src/cli/input.test.ts` (extend)

| Test | What it proves |
|---|---|
| `loadHistory(cwd1)` and `loadHistory(cwd2)` return independent histories | Per-CWD isolation |
| `saveHistory` + `loadHistory` round-trip in same CWD | Persistence |
| History file does not exist → `loadHistory` returns `[]` | Missing file |
| History capped at `MAX_HISTORY` entries on save | Cap enforcement |

### REPL integration (manual)

The REPL handler change is a two-line wiring update in `repl.ts`. Covered by the `mentions.test.ts` unit tests on `expandMentions()`; no separate REPL integration test is required.

---

## File change summary

| Action | File |
|---|---|
| Create | `src/cli/mentions.ts` |
| Create | `src/cli/mentions.test.ts` |
| Modify | `src/cli/input.ts` — `loadHistory(cwd)` + `saveHistory(history, cwd)`; `historyFile(cwd)` helper |
| Modify | `src/cli/input.test.ts` — per-CWD isolation tests |
| Modify | `src/cli/repl.ts` — call `expandMentions()` after `readLine()`; pass `process.cwd()` to `loadHistory`/`saveHistory` |

No changes to `core/`, `providers/`, `tools/`, `skills/`, or `state/`.
