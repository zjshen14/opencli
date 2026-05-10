import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Override AGENT_DIR before importing the module under test
const fakeAgentDir = join(tmpdir(), "opencli-input-history-test");
vi.mock("../state/config.js", () => ({ AGENT_DIR: fakeAgentDir }));

const { loadHistory, saveHistory } = await import("./input.js");

beforeEach(async () => {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(fakeAgentDir, { recursive: true });
});

afterEach(async () => {
  await rm(fakeAgentDir, { recursive: true, force: true });
});

describe("loadHistory / saveHistory", () => {
  it("returns empty array for a fresh CWD", async () => {
    const result = await loadHistory("/some/new/project");
    expect(result).toEqual([]);
  });

  it("persists and reloads history for a given CWD", async () => {
    const cwd = "/home/user/project-a";
    // history array is newest-first (readline convention), same order is restored
    await saveHistory(["cmd three", "cmd two", "cmd one"], cwd);
    const loaded = await loadHistory(cwd);
    expect(loaded).toEqual(["cmd three", "cmd two", "cmd one"]);
  });

  it("isolates history between different CWDs", async () => {
    const cwdA = "/home/user/project-a";
    const cwdB = "/home/user/project-b";
    await saveHistory(["alpha"], cwdA);
    await saveHistory(["beta"], cwdB);
    const a = await loadHistory(cwdA);
    const b = await loadHistory(cwdB);
    expect(a).toContain("alpha");
    expect(a).not.toContain("beta");
    expect(b).toContain("beta");
    expect(b).not.toContain("alpha");
  });

  it("caps history at 500 entries", async () => {
    const cwd = "/home/user/project-cap";
    const history = Array.from({ length: 600 }, (_, i) => `cmd-${i}`);
    await saveHistory(history, cwd);
    const loaded = await loadHistory(cwd);
    expect(loaded.length).toBeLessThanOrEqual(500);
  });
});
