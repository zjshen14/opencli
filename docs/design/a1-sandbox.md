# Design: A1 — Sandbox runtime abstraction for `bash`

_Status: Implemented — merged in [c09fc57](https://github.com/zjshen14/opencli/commit/c09fc57) (2026-05-09). Tracking issue: [#79](https://github.com/zjshen14/opencli/issues/79). Phase: [Roadmap A1](../roadmap.md)._

---

## Problem and goal

`bash.ts` currently calls `spawn("bash", ["-c", cmd])` directly on the host. HITL confirmation gates whether the command runs, but once approved it has unrestricted access to the filesystem and network. This is the largest security surface in the codebase, and it will grow with every new tool added in Phase A.

**Goal:** wrap `bash` execution in an OS-level sandbox that denies network access and writes outside the project working directory, with zero new npm dependencies. The abstraction (`SandboxRunner`) must be pluggable so future isolation strategies (Docker, Firecracker) can be swapped in without touching `bash.ts`.

### What this does NOT replace

- **HITL confirmation** still fires before the runner is called. The sandbox is a second layer — defence-in-depth, not a replacement for the confirmation gate.
- **Path validation** in `write`/`edit` tools is unchanged. Those tools validate paths at the application layer. This design only covers `bash`.

---

## Interface contracts

### New files

```
src/tools/exec/sandbox/
  types.ts          SandboxMode, SandboxExecOptions, SandboxExecResult, SandboxRunner
  passthrough.ts    PassthroughRunner  (wraps current spawn logic; mode "off")
  sandbox-exec.ts   SandboxExecRunner  (macOS sandbox-exec)
  bwrap.ts          BwrapRunner        (Linux bubblewrap)
  index.ts          createSandboxRunner() factory
```

### `types.ts`

```typescript
export type SandboxMode = "auto" | "strict" | "off";

export interface SandboxExecOptions {
  /** Absolute path; always under process.cwd() — enforced by createBashTool(). */
  cwd: string;
  /** Milliseconds before SIGTERM is sent. Default: 30_000. */
  timeout?: number;
  /** Environment passed to the child. Default: process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  /** Exit code of the child process. -1 if killed by timeout or SIGTERM. */
  exitCode: number;
}

export interface SandboxRunner {
  /** Effective sandbox mode (may differ from requested mode on fallback). */
  readonly mode: SandboxMode;

  /**
   * Non-null when the requested mode could not be fully enforced.
   * The CLI emits this exactly once at startup via a stderr warning.
   * Null means full isolation is active.
   */
  readonly warning: string | null;

  exec(command: string, opts: SandboxExecOptions): Promise<SandboxExecResult>;
}
```

### `index.ts` — factory

```typescript
import { SandboxMode, SandboxRunner } from "./types.js";
import { PassthroughRunner } from "./passthrough.js";
import { SandboxExecRunner } from "./sandbox-exec.js";
import { BwrapRunner } from "./bwrap.js";

/**
 * Creates the appropriate SandboxRunner for the current platform and mode.
 * Falls back to PassthroughRunner (with a warning) when the platform tool
 * is missing or when running on Windows.
 *
 * @param cwd  Project root — the directory that sandbox profiles allow writes to.
 *             Pass process.cwd() at startup; do not use a per-call cwd.
 */
export function createSandboxRunner(mode: SandboxMode, cwd: string): SandboxRunner {
  if (mode === "off") return new PassthroughRunner("off");

  if (process.platform === "darwin") {
    return new SandboxExecRunner(mode, cwd);
  }
  if (process.platform === "linux") {
    return new BwrapRunner(mode, cwd);
  }

  // Windows and unknown platforms: passthrough with a warning
  return new PassthroughRunner(
    mode,
    `Sandbox not supported on ${process.platform}; running without isolation`,
  );
}
```

---

## Changed files

### `bash.ts` — convert singleton to factory

**Current:** exports `bashTool` as a singleton object.

**After:** exports `createBashTool(runner: SandboxRunner): Tool`.

Key changes:
1. Remove the inner `spawn` call. Replace with `await runner.exec(cmd, { cwd, timeout: TIMEOUT_MS, env: process.env })`.
2. Map `SandboxExecResult` to `ToolResult`:
   - `exitCode === 0` → `success: true`
   - `exitCode !== 0` → `success: false`, `error: "Exited with code <N>"` (or `"Timed out"` if exitCode is -1)
   - Combine `stdout + stderr` as `output` (same as current behaviour).
3. Add a guard: if `cwd` arg from model is non-null and is not under `process.cwd()`, return an error immediately without calling the runner. This prevents the model from directing writes to arbitrary directories even in `mode="off"`.

```typescript
// bash.ts — after

import { spawn } from "node:child_process";
import { relative } from "node:path";
import type { Tool } from "../base.js";
import type { SandboxRunner } from "./sandbox/types.js";

const TIMEOUT_MS = 30_000;
const SAFE_COMMANDS = [ /* unchanged */ ];

export function createBashTool(runner: SandboxRunner): Tool {
  return {
    name: "bash",
    description: "Execute a shell command and return its output. ...",
    parameters: { /* unchanged */ },
    requiresConfirmation(args): boolean {
      const cmd = (args.command as string).trim();
      return !SAFE_COMMANDS.some((p) => p.test(cmd));
    },
    async execute({ command, cwd: cwdArg }) {
      const cmd = command as string;
      const cwd = (cwdArg as string | undefined) ?? process.cwd();

      // Reject model-specified cwd outside project root
      const rel = relative(process.cwd(), cwd);
      if (rel.startsWith("..")) {
        return {
          success: false,
          output: "",
          error: `cwd '${cwd}' is outside the project root — blocked for safety`,
        };
      }

      const result = await runner.exec(cmd, { cwd, timeout: TIMEOUT_MS, env: process.env });
      const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");

      return {
        success: result.exitCode === 0,
        output: combined || "(no output)",
        error:
          result.exitCode === 0
            ? undefined
            : result.exitCode === -1
              ? `Command timed out after ${TIMEOUT_MS}ms`
              : `Exited with code ${result.exitCode}`,
      };
    },
  };
}
```

### `tools/index.ts` — accept runner

```typescript
// before
export function createDefaultRegistry(model?: string): ToolRegistry

// after
export function createDefaultRegistry(model?: string, runner?: SandboxRunner): ToolRegistry
```

Inside: replace `bashTool` with `createBashTool(runner ?? new PassthroughRunner("off"))`.

Import `PassthroughRunner` from `./exec/sandbox/index.js` as the fallback when no runner is injected (preserves backward compatibility with callers that don't pass a runner, including tests).

### `state/config.ts` — add `sandbox` field

```typescript
export interface Config {
  // ...existing fields...
  sandbox?: SandboxMode;   // default: "auto" when absent
}
```

No default in `DEFAULTS` constant — treat absence as `"auto"` at the resolution site in the CLI layer.

### `cli/index.ts` — resolve mode and create runner

In the `chat` and `run` command handlers, before constructing the tool registry:

```typescript
// Resolution order: CLI flag > env var > config > "auto"
function resolveSandboxMode(flags: { sandbox?: string }, config: Config): SandboxMode {
  const raw = flags.sandbox ?? process.env.OPENCLI_SANDBOX ?? config.sandbox ?? "auto";
  if (raw === "auto" || raw === "strict" || raw === "off") return raw;
  throw new Error(`Invalid --sandbox value '${raw}'. Valid values: auto, strict, off`);
}

const sandboxMode = resolveSandboxMode(options, config);
const runner = createSandboxRunner(sandboxMode, process.cwd());

if (runner.warning) {
  process.stderr.write(`[opencli] warn: ${runner.warning}\n`);
}

const registry = createDefaultRegistry(model, runner);
```

Add `--sandbox <mode>` option to both `chat` and `run` commander commands.

---

## Per-platform implementation

### macOS — `SandboxExecRunner`

Uses the built-in `/usr/bin/sandbox-exec` binary (present on all macOS versions; see open question Q1).

**Profile** is written once at runner construction to a temp file. Use `crypto.randomUUID()` for the filename:

```
/tmp/opencli-sandbox-<uuid>.sb
```

Register a `process.on("exit")` hook to delete the file. The file is created with `0o600` permissions.

**Auto profile** (`mode === "auto"`):

```scheme
(version 1)

; Deny everything not explicitly allowed below.
(deny default)

; Process lifecycle — needed for almost all programs.
(allow process*)
(allow signal)
(allow sysctl-read)
(allow mach*)
(allow ipc*)

; Reads: allow everywhere (auto mode — strict reads come in mode "strict").
(allow file-read*)

; Writes: allow only inside the project root and system temp dirs.
(allow file-write* (subpath "CWD_PLACEHOLDER"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "/var/folders"))

; Network: deny all. Commands that need network will get a connection-refused
; or permission-denied error, which propagates to the model as stderr.
(deny network*)
```

`CWD_PLACEHOLDER` is replaced at construction time with `cwd` (absolute path). Do not regenerate the profile per call — the runner is scoped to `process.cwd()` at startup.

**Strict profile** — see open question Q3. Stub for A1.

**Invocation:**

```typescript
spawn("/usr/bin/sandbox-exec", ["-f", this.profilePath, "/bin/sh", "-c", command], {
  cwd: opts.cwd,
  env: opts.env ?? process.env,
  stdio: ["ignore", "pipe", "pipe"],
})
```

Timeout and result collection: identical to the current `bash.ts` spawn logic. Move the shared implementation into a private `spawnAndCollect(proc, timeout)` helper used by both `PassthroughRunner` and `SandboxExecRunner`.

**Detection:** `/usr/bin/sandbox-exec` is always present on macOS. No runtime detection needed. Construction never throws.

**`warning`:** always null for `SandboxExecRunner` (full isolation available).

---

### Linux — `BwrapRunner`

Uses `bwrap` (bubblewrap) via user namespaces. No setuid required when `unprivileged_userns_clone=1` (Ubuntu 18.04+, Fedora, Arch).

**Detection at construction:**

```typescript
import { execFileSync } from "node:child_process";

function detectBwrap(): string | null {
  for (const candidate of ["/usr/bin/bwrap", "/usr/local/bin/bwrap"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "pipe", timeout: 2000 });
      return candidate;
    } catch { /* try next */ }
  }
  return null;
}
```

If not found: `BwrapRunner` sets `warning` and falls back to `PassthroughRunner` behavior internally (delegates all `exec` calls to a `PassthroughRunner` instance).

**Auto invocation:**

```typescript
spawn(bwrapBin, [
  "--unshare-net",          // deny network namespace
  "--ro-bind", "/", "/",   // bind entire host FS read-only
  "--bind", cwd, cwd,      // override CWD as read-write
  "--tmpfs", "/tmp",        // fresh writable tmpfs
  "--dev", "/dev",          // device nodes (needed for many programs)
  "--proc", "/proc",        // procfs (needed for ps, pgrep, etc.)
  "--",
  "/bin/sh", "-c", command,
], { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] })
```

Order matters: `--ro-bind / /` first (everything read-only), then `--bind <cwd> <cwd>` (override just CWD as read-write). Bwrap applies mounts in argument order, so later mounts take precedence.

Note: `--ro-bind / /` allows reads of `~/.gitconfig`, `~/.npmrc`, `/etc/resolv.conf`, etc. — these are not denied in `auto` mode (network is denied at the namespace level, not DNS config reads).

**Strict mode** — see open question Q3. Stub for A1.

---

### `PassthroughRunner`

Wraps the current `bash.ts` spawn logic exactly. `mode: "off"` (or the requested mode, if downgraded). Optionally holds a warning string set at construction.

```typescript
export class PassthroughRunner implements SandboxRunner {
  readonly mode: SandboxMode;
  readonly warning: string | null;

  constructor(mode: SandboxMode, warning: string | null = null) {
    this.mode = mode;
    this.warning = warning;
  }

  async exec(command: string, opts: SandboxExecOptions): Promise<SandboxExecResult> {
    return spawnAndCollect(
      spawn("bash", ["-c", command], {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      opts.timeout ?? 30_000,
    );
  }
}
```

`spawnAndCollect(proc, timeoutMs): Promise<SandboxExecResult>` is a shared helper that handles stdout/stderr collection and the kill-on-timeout logic. Both `PassthroughRunner` and `SandboxExecRunner` use it. Extract from current `bash.ts`.

---

## Failure modes

Every failure mode must produce a `SandboxExecResult` (never throw), unless construction itself fails — in which case `createSandboxRunner` falls back to `PassthroughRunner`.

| Scenario | Behaviour |
|---|---|
| `sandbox-exec` not at `/usr/bin/sandbox-exec` | `SandboxExecRunner` constructor logs warning, delegates to `PassthroughRunner` |
| Profile temp file write fails | `SandboxExecRunner` constructor logs warning, delegates to `PassthroughRunner` |
| `bwrap` not installed | `BwrapRunner` constructor sets warning, delegates to `PassthroughRunner` |
| User namespaces disabled on Linux | `bwrap` exits with an error code immediately; treated as `exitCode: 1` with stderr explaining the problem; CLI layer warns once |
| Command denied by sandbox (network access) | Propagates as `exitCode: 1` + relevant error in `stderr` — model sees it as a tool failure |
| Command denied by sandbox (write outside CWD) | Same — `exitCode: 1` + permission-denied error in stderr |
| `cwd` arg from model is outside project root | Caught by `createBashTool` before calling runner; returns `ToolResult` error without invoking runner |
| Command timeout | SIGTERM sent to sandboxed child; result is `exitCode: -1`, `stdout`/`stderr` collected up to that point |
| Profile syntax error (sandbox-exec) | `sandbox-exec` exits with non-zero before spawning the shell; stderr contains the SBPL error — propagated as `exitCode: 1` |
| `mode` value in config is invalid | Caught by `resolveSandboxMode()` at startup with a clear error message |

---

## Migration plan

### Existing tests

`src/tools/exec/bash.test.ts` currently imports and tests `bashTool` directly. After this change it imports `createBashTool`.

**Required change to test file:** replace

```typescript
import { bashTool } from "./bash.js";
// use bashTool.execute(...)
```

with

```typescript
import { createBashTool } from "./bash.js";
import { PassthroughRunner } from "./sandbox/passthrough.js";
const bashTool = createBashTool(new PassthroughRunner("off"));
// use bashTool.execute(...)
```

All existing test assertions should pass unchanged — `PassthroughRunner("off")` is bit-identical to the current spawn behaviour.

### Call sites

Two call sites import `bashTool` today:
- `src/tools/index.ts` — handled by the `createDefaultRegistry` signature change above.
- Any tests that import it directly — handled by the migration above.

Run `grep -r "bashTool\|createDefaultRegistry" src/` to confirm these are the only two.

---

## Test strategy

| Test | File | What it proves |
|---|---|---|
| `PassthroughRunner` stdout/stderr collection | `sandbox/passthrough.test.ts` | Bit-identical to current bash.ts spawn |
| `PassthroughRunner` timeout → exitCode -1 | same | Timeout path unchanged |
| `createSandboxRunner("off")` returns `PassthroughRunner` | `sandbox/index.test.ts` | Factory smoke test |
| `createSandboxRunner("auto")` on macOS returns `SandboxExecRunner` | same (conditional) | Platform dispatch |
| `createSandboxRunner("auto")` on Linux returns `BwrapRunner` | same (conditional) | Platform dispatch |
| `SandboxExecRunner`: echo command succeeds | `sandbox/sandbox-exec.test.ts` (macOS only, `test.skipIf`) | Basic invocation |
| `SandboxExecRunner`: `curl https://example.com` is denied | same | Network deny works |
| `SandboxExecRunner`: write inside CWD succeeds | same | CWD allow works |
| `SandboxExecRunner`: write to `/etc/hosts` is denied | same | Write-outside-CWD deny works |
| `BwrapRunner`: same four cases | `sandbox/bwrap.test.ts` (Linux only) | Parity with macOS |
| `createBashTool`: cwd outside project root is rejected | `bash.test.ts` (add one case) | Pre-runner guard |
| All existing `bash.test.ts` cases | `bash.test.ts` | No regression |

Platform-conditional tests use `test.skipIf(process.platform !== "darwin")` / `"linux"`. CI must run on both macOS and Linux runners to get full coverage — flag this in CI config if not already the case.

---

## Open questions

These are the only things the executor must escalate before shipping. Do not guess — raise them on [#79](https://github.com/zjshen14/opencli/issues/79).

**Q1 — macOS `sandbox-exec` deprecation.**
Apple deprecated `sandbox-exec` in macOS 11 (Big Sur, 2020). It remains functional through macOS 15 (Sequoia, 2025) and is still used by Codex CLI. The deprecation notice has existed for 5+ years with no removal. Is shipping on a deprecated API acceptable for A1, with a note to revisit before any 1.0 release? Alternatives (App Sandbox, seatbelt) require code signing and are far heavier.
_Recommendation: ship it. Flag in README as "best-effort on macOS; container mode (C4) is the production-grade alternative."_

**Q2 — `strict` mode scope for A1.**
Strict mode (deny reads outside CWD) requires carefully allow-listing system paths that vary by distro and macOS version (`/usr`, `/bin`, `/lib`, `/nix`, `/opt/homebrew`, etc.). This is non-trivial to get right and will produce false positives (breaking legitimate tool use).
_Recommendation: implement `strict` as a stub that logs `"strict mode not yet implemented; using auto"` and falls back. Mark it as `experimental` in docs. Full `strict` is follow-on work._

**Q3 — bwrap on distributions with namespaces disabled.**
On some Debian/RHEL configurations, `unprivileged_userns_clone=0`. The `BwrapRunner` will detect this at first `exec()` call (not at construction), because `bwrap --version` succeeds but `bwrap --unshare-net ...` fails. The current design detects bwrap at construction but not namespace availability.
_Recommendation: run a one-shot probe at construction — `bwrap --unshare-net --ro-bind /bin /bin /bin/true` — to confirm namespaces work. If it fails, set `warning` and fall back to `PassthroughRunner`._

**Q4 — SIGINT forwarding.**
If the user hits Ctrl+C in the REPL while a sandboxed command is running, the signal goes to the Node process. The sandboxed child is in a different process group and may not receive it. This means Ctrl+C currently relies on the 30s timeout to kill a stuck sandboxed command.
_Recommendation: out of scope for A1. Document as a known limitation. Proper fix requires the runner to expose a `kill()` method and the REPL to call it on SIGINT. Track as a follow-up._

---

## File change summary

| Action | File |
|---|---|
| Create | `src/tools/exec/sandbox/types.ts` |
| Create | `src/tools/exec/sandbox/passthrough.ts` |
| Create | `src/tools/exec/sandbox/sandbox-exec.ts` |
| Create | `src/tools/exec/sandbox/bwrap.ts` |
| Create | `src/tools/exec/sandbox/index.ts` |
| Create | `src/tools/exec/sandbox/passthrough.test.ts` |
| Create | `src/tools/exec/sandbox/sandbox-exec.test.ts` |
| Create | `src/tools/exec/sandbox/bwrap.test.ts` |
| Create | `src/tools/exec/sandbox/index.test.ts` |
| Modify | `src/tools/exec/bash.ts` — `bashTool` → `createBashTool(runner)` |
| Modify | `src/tools/exec/bash.test.ts` — update import + add cwd-guard test |
| Modify | `src/tools/index.ts` — `createDefaultRegistry(model?, runner?)` |
| Modify | `src/state/config.ts` — add `sandbox?: SandboxMode` to `Config` |
| Modify | `src/cli/index.ts` — resolve mode, create runner, emit warning, pass to registry |
| Update | `README.md` — document `--sandbox` flag and `OPENCLI_SANDBOX` env var |
| Update | `docs/architecture.md` — add sandbox layer to Tool System section |
