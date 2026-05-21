import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { PassthroughRunner, spawnAndCollect } from "./passthrough.js";
import type { SandboxExecOptions, SandboxExecResult, SandboxMode, SandboxRunner } from "./types.js";

const SANDBOX_EXEC_BIN = "/usr/bin/sandbox-exec";

function buildAutoProfile(cwd: string, homeDir: string): string {
  return `(version 1)

; Deny everything not explicitly allowed below.
(deny default)

; Process lifecycle — needed for almost all programs.
(allow process*)
(allow process-info*)
(allow signal)
(allow sysctl-read)
(allow mach*)
(allow ipc*)

; Reads: allow everywhere (auto mode).
(allow file-read*)

; Writes: allow only inside the project root and system temp dirs.
(allow file-write* (subpath "${cwd}"))
(allow file-write* (subpath "/private/tmp"))
; /var/folders is a symlink to /private/var/folders on macOS — allow both forms.
(allow file-write* (subpath "/var/folders"))
(allow file-write* (subpath "/private/var/folders"))

; Package-manager caches — allow npm, pip, cargo, yarn, pnpm, gem, etc. to write
; to their standard locations so 'npm install' / 'pip install' / 'cargo build' work.
(allow file-write* (subpath "${homeDir}/.npm"))
(allow file-write* (subpath "${homeDir}/.cache"))
(allow file-write* (subpath "${homeDir}/.cargo"))
(allow file-write* (subpath "${homeDir}/.local"))
(allow file-write* (subpath "${homeDir}/.yarn"))
(allow file-write* (subpath "${homeDir}/.gem"))
(allow file-write* (subpath "${homeDir}/.config"))

; Network policy: allow loopback for local dev servers plus external HTTPS/HTTP
; and DNS so package registries (npm, PyPI, crates.io), gh, and curl work.
; 'auto' mode is "prevent obvious accidents", not a real security boundary —
; use --sandbox off or wait for 'strict' mode for true isolation.
(allow network-bind)
(allow network-inbound)
(allow network-outbound (remote ip "localhost:*"))
; Unix domain sockets stay open (used by many local tools, e.g. PostgreSQL).
(allow network* (remote unix-socket))
(allow network* (local unix-socket))
; External HTTPS/HTTP for npm install, pip install, cargo build, gh, curl, etc.
(allow network-outbound (remote ip "*:443"))
(allow network-outbound (remote ip "*:80"))
; DNS — needed for any external hostname resolution.
(allow network-outbound (remote ip "*:53"))
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

    this.profilePath = join("/tmp", `opencli-sandbox-${randomUUID()}.sb`);

    this.ready = writeFile(this.profilePath, buildAutoProfile(cwd, homedir()), { mode: 0o600 })
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
    });

    return spawnAndCollect(proc, opts.timeout ?? 30_000);
  }
}
