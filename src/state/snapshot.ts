import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface RewindResult {
  ok: boolean;
  /** Relative paths of files restored. Empty if nothing was reverted. */
  restoredFiles: string[];
  error?: string;
}

export class SnapshotManager {
  private repoRoot: string | undefined;
  private stashSha: string | undefined;
  private _lastSnapshotSha: string | undefined;
  private _gitAvailable = true; // optimistic until a capture() fails
  private _pendingWarning: string | undefined;

  get hasSnapshot(): boolean {
    return this.stashSha !== undefined;
  }

  get gitAvailable(): boolean {
    return this._gitAvailable;
  }

  get snapshotEnabled(): boolean {
    return process.env.OPENCLI_SNAPSHOT !== "off";
  }

  get lastSnapshotSha(): string | undefined {
    return this._lastSnapshotSha;
  }

  drainWarning(): string | null {
    const w = this._pendingWarning ?? null;
    this._pendingWarning = undefined;
    return w;
  }

  async capture(cwd: string): Promise<void> {
    if (!this.snapshotEnabled) return;
    if (this._gitAvailable === false) return; // already failed this session

    try {
      // Resolve repo root once so all git ops are repo-root-relative.
      if (!this.repoRoot) {
        const { stdout } = await execAsync("git rev-parse --show-toplevel", { cwd });
        this.repoRoot = stdout.trim();
        this._gitAvailable = true;
      }

      // git stash create returns the stash commit SHA, or "" if the working tree is clean.
      // Retry once after 50ms on index.lock contention.
      let sha = "";
      try {
        const { stdout } = await execAsync("git stash create", { cwd: this.repoRoot });
        sha = stdout.trim();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("index.lock")) {
          await new Promise((r) => setTimeout(r, 50));
          const { stdout } = await execAsync("git stash create", { cwd: this.repoRoot });
          sha = stdout.trim();
        } else {
          throw err;
        }
      }

      if (sha) {
        this.stashSha = sha;
        this._lastSnapshotSha = sha;
      }
      // Empty stdout = clean tree; no snapshot needed.
    } catch (err) {
      this._gitAvailable = false;
      this._pendingWarning = err instanceof Error ? err.message : "git snapshot unavailable";
    }
  }

  async rewind(): Promise<RewindResult> {
    if (!this.stashSha || !this.repoRoot) {
      return { ok: false, restoredFiles: [], error: "No snapshot available for this session." };
    }
    const sha = this.stashSha;
    try {
      // List files that differ between snapshot and current working tree.
      const { stdout: diffOut } = await execAsync(`git diff --name-only ${sha}`, {
        cwd: this.repoRoot,
      });
      const restoredFiles = diffOut.trim().split("\n").filter(Boolean);

      // Restore working tree only; index is left untouched (requires git ≥ 2.23).
      await execAsync(`git restore --source ${sha} --worktree .`, { cwd: this.repoRoot });

      this.stashSha = undefined; // consumed; _lastSnapshotSha kept for diagnostics
      return { ok: true, restoredFiles };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // stashSha left set — user can retry or recover manually using lastSnapshotSha
      return { ok: false, restoredFiles: [], error: message };
    }
  }
}
