import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SnapshotManager } from "./snapshot.js";

const execAsync = promisify(exec);

async function initRepo(dir: string): Promise<void> {
  await execAsync("git init", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
  await writeFile(join(dir, "file.txt"), "initial\n");
  await execAsync("git add .", { cwd: dir });
  await execAsync('git commit -m "init"', { cwd: dir });
}

describe("SnapshotManager", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `snapshot-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await initRepo(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.OPENCLI_SNAPSHOT;
  });

  it("capture() on clean tree: no SHA stored, hasSnapshot = false", async () => {
    const mgr = new SnapshotManager();
    await mgr.capture(dir);
    expect(mgr.hasSnapshot).toBe(false);
    expect(mgr.gitAvailable).toBe(true);
    expect(mgr.lastSnapshotSha).toBeUndefined();
  });

  it("capture() on dirty tree: SHA stored, hasSnapshot = true", async () => {
    await writeFile(join(dir, "file.txt"), "modified\n");
    const mgr = new SnapshotManager();
    await mgr.capture(dir);
    expect(mgr.hasSnapshot).toBe(true);
    expect(mgr.gitAvailable).toBe(true);
    expect(mgr.lastSnapshotSha).toBeDefined();
  });

  it("capture() in non-git dir: gitAvailable = false, drainWarning() returns message", async () => {
    const nonGit = join(tmpdir(), `no-git-${Date.now()}`);
    await mkdir(nonGit, { recursive: true });
    try {
      const mgr = new SnapshotManager();
      await mgr.capture(nonGit);
      expect(mgr.gitAvailable).toBe(false);
      const warn = mgr.drainWarning();
      expect(warn).not.toBeNull();
    } finally {
      await rm(nonGit, { recursive: true, force: true });
    }
  });

  it("capture() from subdirectory: repoRoot set to repo root", async () => {
    const sub = join(dir, "subdir");
    await mkdir(sub, { recursive: true });
    await writeFile(join(dir, "file.txt"), "modified\n");
    const mgr = new SnapshotManager();
    await mgr.capture(sub);
    expect(mgr.hasSnapshot).toBe(true);
    // Make a further change so rewind has a diff to restore
    await writeFile(join(dir, "file.txt"), "further change\n");
    const result = await mgr.rewind();
    expect(result.ok).toBe(true);
    expect(result.restoredFiles).toContain("file.txt");
  });

  it("capture() with OPENCLI_SNAPSHOT=off: no-op, gitAvailable stays true", async () => {
    process.env.OPENCLI_SNAPSHOT = "off";
    await writeFile(join(dir, "file.txt"), "modified\n");
    const mgr = new SnapshotManager();
    await mgr.capture(dir);
    expect(mgr.hasSnapshot).toBe(false);
    expect(mgr.gitAvailable).toBe(true);
  });

  it("rewind() with no snapshot: returns ok:false", async () => {
    const mgr = new SnapshotManager();
    const result = await mgr.rewind();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no snapshot/i);
  });

  it("rewind() restores a tracked modified file", async () => {
    await writeFile(join(dir, "file.txt"), "modified\n");
    const mgr = new SnapshotManager();
    await mgr.capture(dir);
    expect(mgr.hasSnapshot).toBe(true);

    // Make further changes after snapshot
    await writeFile(join(dir, "file.txt"), "further change\n");

    const result = await mgr.rewind();
    expect(result.ok).toBe(true);
    expect(result.restoredFiles).toContain("file.txt");
    expect(mgr.hasSnapshot).toBe(false);
  });

  it("rewind() leaves pre-existing staged changes untouched (--worktree only)", async () => {
    // Stage an unrelated change
    await writeFile(join(dir, "staged.txt"), "staged content\n");
    await execAsync("git add staged.txt", { cwd: dir });

    // Dirty file.txt (for snapshot)
    await writeFile(join(dir, "file.txt"), "modified\n");
    const mgr = new SnapshotManager();
    await mgr.capture(dir);

    // Rewind file.txt
    await writeFile(join(dir, "file.txt"), "more changes\n");
    const result = await mgr.rewind();
    expect(result.ok).toBe(true);

    // staged.txt should still be staged (index untouched)
    const { stdout } = await execAsync("git diff --cached --name-only", { cwd: dir });
    expect(stdout).toContain("staged.txt");
  });

  it("lastSnapshotSha remains set after successful rewind", async () => {
    await writeFile(join(dir, "file.txt"), "modified\n");
    const mgr = new SnapshotManager();
    await mgr.capture(dir);
    const sha = mgr.lastSnapshotSha;
    expect(sha).toBeDefined();

    await mgr.rewind();
    expect(mgr.hasSnapshot).toBe(false);
    expect(mgr.lastSnapshotSha).toBe(sha); // still set for diagnostics
  });

  it("second rewind() call returns hasSnapshot = false and ok:false", async () => {
    await writeFile(join(dir, "file.txt"), "modified\n");
    const mgr = new SnapshotManager();
    await mgr.capture(dir);
    await mgr.rewind();

    const second = await mgr.rewind();
    expect(second.ok).toBe(false);
    expect(mgr.hasSnapshot).toBe(false);
  });

  it("drainWarning() clears the warning on first read", async () => {
    const nonGit = join(tmpdir(), `no-git2-${Date.now()}`);
    await mkdir(nonGit, { recursive: true });
    try {
      const mgr = new SnapshotManager();
      await mgr.capture(nonGit);
      const first = mgr.drainWarning();
      const second = mgr.drainWarning();
      expect(first).not.toBeNull();
      expect(second).toBeNull(); // consumed
    } finally {
      await rm(nonGit, { recursive: true, force: true });
    }
  });

  it("snapshotEnabled reflects OPENCLI_SNAPSHOT env var", () => {
    const mgr = new SnapshotManager();
    expect(mgr.snapshotEnabled).toBe(true);
    process.env.OPENCLI_SNAPSHOT = "off";
    expect(mgr.snapshotEnabled).toBe(false);
  });
});
