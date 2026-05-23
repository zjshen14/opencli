import { spawn } from "node:child_process";
import type { SandboxExecOptions, SandboxExecResult, SandboxMode, SandboxRunner } from "./types.js";

// Grace period between SIGTERM and SIGKILL when a timeout fires.
const KILL_GRACE_MS = 2_000;
// Extra wait after SIGKILL before we give up on `close` and force-resolve.
// Backgrounded grandchildren can keep stdio pipes open even after the
// immediate child dies; without this, the Promise would never resolve.
const FORCE_RESOLVE_MS = 500;

/**
 * Collect stdout/stderr from a spawned process and resolve when it closes.
 *
 * Timeout semantics:
 *   - At timeoutMs, send SIGTERM to the process group (proc must be spawned
 *     with detached: true so killing -proc.pid targets the group, not just
 *     the immediate child).
 *   - If the process hasn't closed after KILL_GRACE_MS, send SIGKILL.
 *   - If `close` still hasn't fired after FORCE_RESOLVE_MS (typically
 *     because a backgrounded grandchild is still holding stdio pipes open),
 *     force-resolve the Promise with exitCode -1 so the bash tool unblocks.
 */
export async function spawnAndCollect(
  proc: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<SandboxExecResult> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let resolved = false;
    let timedOut = false;

    proc.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    const finish = (exitCode: number): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(forceTimer);
      // Detach stdio so a stuck grandchild can't keep this Promise alive
      // through the Node event loop after we've already given up.
      try {
        proc.stdout?.destroy();
      } catch {
        // ignore
      }
      try {
        proc.stderr?.destroy();
      } catch {
        // ignore
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8").trimEnd(),
        stderr: Buffer.concat(stderr).toString("utf8").trimEnd(),
        exitCode,
      });
    };

    const killGroup = (signal: NodeJS.Signals): void => {
      if (proc.pid === undefined) return;
      try {
        // Negative PID targets the process group — works only when the proc
        // was spawned with detached: true. Falls back to direct child kill.
        process.kill(-proc.pid, signal);
      } catch {
        try {
          proc.kill(signal);
        } catch {
          // already gone
        }
      }
    };

    let killTimer: NodeJS.Timeout = setTimeout(() => {}, 0);
    let forceTimer: NodeJS.Timeout = setTimeout(() => {}, 0);
    clearTimeout(killTimer);
    clearTimeout(forceTimer);

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => {
        killGroup("SIGKILL");
        forceTimer = setTimeout(() => {
          if (!resolved) {
            stderr.push(
              Buffer.from(
                "\n[opencli] command timed out; backgrounded child still holding stdio — forcing detach.\n",
              ),
            );
            finish(-1);
          }
        }, FORCE_RESOLVE_MS);
      }, KILL_GRACE_MS);
    }, timeoutMs);

    proc.on("close", (code) => {
      finish(timedOut ? -1 : (code ?? 1));
    });

    proc.on("error", () => {
      finish(-1);
    });
  });
}

export class PassthroughRunner implements SandboxRunner {
  readonly mode: SandboxMode;
  readonly warning: string | null;

  constructor(mode: SandboxMode, warning: string | null = null) {
    this.mode = mode;
    this.warning = warning;
  }

  async exec(command: string, opts: SandboxExecOptions): Promise<SandboxExecResult> {
    const proc = spawn("bash", ["-c", command], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // detached: shell becomes its own process group leader so we can
      // kill the whole group (including backgrounded grandchildren) on timeout.
      detached: true,
    });
    return spawnAndCollect(proc, opts.timeout ?? 30_000);
  }
}
