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

; Network: deny all.
(deny network*)
`;
}

export class SandboxExecRunner implements SandboxRunner {
  readonly mode: SandboxMode;
  readonly warning: string | null = null;

  private profilePath: string;
  private ready: Promise<void>;
  private fallback: PassthroughRunner | null = null;

  constructor(mode: SandboxMode, cwd: string) {
    // strict is stubbed — fall back to auto
    this.mode = mode === "strict" ? "auto" : mode;
    const effectiveMode = this.mode;

    if (mode === "strict") {
      process.stderr.write(
        "[opencli] warn: strict mode not yet implemented; falling back to auto\n",
      );
    }

    this.profilePath = join("/tmp", `opencli-sandbox-${randomUUID()}.sb`);

    this.ready = writeFile(this.profilePath, buildAutoProfile(cwd), { mode: 0o600 }).catch(
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.fallback = new PassthroughRunner(
          effectiveMode,
          `sandbox-exec profile write failed (${msg}); running without isolation`,
        );
      },
    );

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
