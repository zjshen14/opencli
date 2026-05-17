import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PassthroughRunner, spawnAndCollect } from "./passthrough.js";
import type { SandboxExecOptions, SandboxExecResult, SandboxMode, SandboxRunner } from "./types.js";

const SANDBOX_EXEC_BIN = "/usr/bin/sandbox-exec";

function buildAutoProfile(cwd: string): string {
  return `(version 1)

; Deny everything not explicitly allowed below.
(deny default)

; Process lifecycle — needed for almost all programs.
(allow process*)
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

; Network policy — intent: agent can run tests / dev servers that bind to
; loopback, but cannot exfiltrate data to the public internet.
; - Bind is harmless on any interface; allow it (the deny on outbound below
;   prevents using a bound socket to reach external hosts).
; - Inbound: accept connections on bound sockets (supertest, jest, etc.).
; - Outbound: allow loopback only. The sandbox-exec address grammar only
;   accepts "*" or "localhost" as the host literal — "localhost" matches both
;   127.0.0.1 and ::1.
(allow network-bind)
(allow network-inbound)
(allow network-outbound (remote ip "localhost:*"))
; Unix domain sockets stay open (used by many local tools, e.g. PostgreSQL).
(allow network* (remote unix-socket))
(allow network* (local unix-socket))
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

    this.ready = writeFile(this.profilePath, buildAutoProfile(cwd), { mode: 0o600 })
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
