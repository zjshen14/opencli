import { spawn } from "node:child_process";
import type { SandboxExecOptions, SandboxExecResult, SandboxMode, SandboxRunner } from "./types.js";

export async function spawnAndCollect(
  proc: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<SandboxExecResult> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    proc.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    let timedOut = false;
    let settled = false;

    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8").trimEnd(),
        stderr: Buffer.concat(stderr).toString("utf8").trimEnd(),
        exitCode,
      });
    };

    // Kill the entire process group so backgrounded children (which inherit
    // the pipe FDs) also receive the signal and release the pipes.
    const killGroup = (sig: NodeJS.Signals) => {
      if (proc.pid === undefined) return;
      try {
        process.kill(-proc.pid, sig);
      } catch {
        // group already gone; fall back to killing the individual process
        try {
          proc.kill(sig);
        } catch {
          // already dead
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      // If close still hasn't fired after a grace period (backgrounded children
      // may hold the pipe FDs open even after their parent shell exits), force-
      // resolve and destroy the streams to release the event-loop references.
      const killTimer = setTimeout(() => {
        killGroup("SIGKILL");
        proc.stdout?.destroy();
        proc.stderr?.destroy();
        settle(-1);
      }, 2_000);
      killTimer.unref();
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      settle(timedOut ? -1 : (code ?? 1));
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
    // detached: true makes the child a process group leader so killGroup()
    // can send signals to the entire group (including backgrounded children).
    const proc = spawn("bash", ["-c", command], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    return spawnAndCollect(proc, opts.timeout ?? 30_000);
  }
}
