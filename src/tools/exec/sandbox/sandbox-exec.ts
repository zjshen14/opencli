import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassthroughRunner, spawnAndCollect } from "./passthrough.js";
import type { SandboxExecOptions, SandboxExecResult, SandboxMode, SandboxRunner } from "./types.js";

const SANDBOX_EXEC_BIN = "/usr/bin/sandbox-exec";

// auto mode is intentionally NOT a security boundary — see
// docs/design/a7-sandbox-loosen-auto.md. The goal is to prevent obvious
// accidents (writes to /etc, ~/.ssh, etc.) while letting normal coding
// workflows (npm install, pip install, gh, curl) work.
function buildAutoProfile(cwd: string, home: string): string {
  return `(version 1)

(deny default)

; Process lifecycle
(allow process*)
(allow signal)
(allow sysctl-read)
(allow mach*)
(allow ipc*)

; Process introspection — needed for /bin/ps, /usr/bin/top, etc.
(allow process-info* (target others))

; Reads: allow everywhere.
(allow file-read*)

; Writes: project root + system temp + common dev-tooling locations.
(allow file-write* (subpath "${cwd}"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "/var/folders"))
(allow file-write* (subpath "/private/var/folders"))

; Standard device nodes — explicit literals rather than (subpath "/dev") to
; keep the allow surface narrow. Needed for curl -o /dev/null, shell
; redirects, /dev/tty prompts, etc.
(allow file-write*
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/tty")
  (literal "/dev/urandom")
  (literal "/dev/random"))

; XDG base directories
(allow file-write* (subpath "${home}/.cache"))
(allow file-write* (subpath "${home}/.config"))
(allow file-write* (subpath "${home}/.local"))

; Package-manager dot-dirs
(allow file-write* (subpath "${home}/.npm"))
(allow file-write* (subpath "${home}/.cargo"))
(allow file-write* (subpath "${home}/.yarn"))
(allow file-write* (subpath "${home}/.pnpm-store"))
(allow file-write* (subpath "${home}/.gem"))
(allow file-write* (subpath "${home}/.gradle"))
(allow file-write* (subpath "${home}/.m2"))
(allow file-write* (subpath "${home}/.rustup"))

; macOS app caches (pip, brew log cache, Ruby gems, etc.)
(allow file-write* (subpath "${home}/Library/Caches"))

; Network: allow all. auto is convenience-first; use strict for isolation.
(allow network*)
`;
}

export class SandboxExecRunner implements SandboxRunner {
  readonly mode: SandboxMode;
  warning: string | null = null;

  private profilePath: string;
  private ready: Promise<void>;
  private fallback: PassthroughRunner | null = null;

  constructor(mode: SandboxMode, cwd: string) {
    // strict is stubbed — fall back to auto
    this.mode = mode === "strict" ? "auto" : mode;
    const effectiveMode = this.mode;

    const home = process.env.HOME ?? homedir();
    this.profilePath = join("/tmp", `opencli-sandbox-${randomUUID()}.sb`);

    this.ready = writeFile(this.profilePath, buildAutoProfile(cwd, home), { mode: 0o600 })
      .then(() => {
        // Only emit the strict-mode warning when the runner will actually execute.
        if (mode === "strict") {
          process.stderr.write(
            "[opencli] warn: strict mode not yet implemented; falling back to auto\n",
          );
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.warning = `sandbox-exec profile write failed (${msg}); running without isolation`;
        this.fallback = new PassthroughRunner(effectiveMode, this.warning);
      });

    process.on("exit", () => {
      unlink(this.profilePath).catch(() => {});
    });
  }

  async exec(command: string, opts: SandboxExecOptions): Promise<SandboxExecResult> {
    await this.ready;

    if (this.fallback) {
      return this.fallback.exec(command, opts);
    }

    const proc = spawn(SANDBOX_EXEC_BIN, ["-f", this.profilePath, "/bin/sh", "-c", command], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // sandbox-exec becomes its own process group leader so spawnAndCollect
      // can kill the whole group (including any backgrounded grandchildren
      // like `npm run dev &`) on timeout via process.kill(-proc.pid, ...).
      detached: true,
    });

    return spawnAndCollect(proc, opts.timeout ?? 30_000);
  }
}
