import type { SandboxMode, SandboxRunner } from "./types.js";
import { PassthroughRunner } from "./passthrough.js";
import { SandboxExecRunner } from "./sandbox-exec.js";
import { BwrapRunner } from "./bwrap.js";

export { PassthroughRunner } from "./passthrough.js";
export { SandboxExecRunner } from "./sandbox-exec.js";
export { BwrapRunner } from "./bwrap.js";
export type { SandboxMode, SandboxExecOptions, SandboxExecResult, SandboxRunner } from "./types.js";

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

  return new PassthroughRunner(
    mode,
    `Sandbox not supported on ${process.platform}; running without isolation`,
  );
}
