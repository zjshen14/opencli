import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSettings, saveSettings } from "./settings.js";

const tmpDir = join(tmpdir(), `opencli-settings-test-${Date.now()}`);

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("loadSettings", () => {
  it("returns empty object when no settings file exists", async () => {
    const s = await loadSettings(tmpDir);
    expect(s).toEqual({});
  });

  it("returns parsed settings when file exists", async () => {
    await saveSettings({ permissions: { allow: ['bash:{"command":"echo hi"}'] } }, tmpDir);
    const s = await loadSettings(tmpDir);
    expect(s.permissions?.allow).toEqual(['bash:{"command":"echo hi"}']);
  });
});

describe("saveSettings", () => {
  it("persists allow list to disk", async () => {
    await saveSettings({ permissions: { allow: ["bash:{}"] } }, tmpDir);
    const s = await loadSettings(tmpDir);
    expect(s.permissions?.allow).toEqual(["bash:{}"]);
  });

  it("merges allow list without overwriting other permissions fields", async () => {
    await saveSettings({ permissions: { allow: ["a"] } }, tmpDir);
    // Simulate a future deny list already in the file
    const dir = join(tmpDir, ".opencli");
    const file = join(dir, "settings.json");
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify({ permissions: { allow: ["a"], deny: ["b"] } }, null, 2));

    await saveSettings({ permissions: { allow: ["a", "c"] } }, tmpDir);
    const s = await loadSettings(tmpDir);
    expect(s.permissions?.allow).toEqual(["a", "c"]);
    expect((s.permissions as Record<string, unknown>)?.deny).toEqual(["b"]);
  });

  it("merges new settings without overwriting unrelated top-level fields", async () => {
    const dir = join(tmpDir, ".opencli");
    const file = join(dir, "settings.json");
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify({ someOtherField: true }, null, 2));

    await saveSettings({ permissions: { allow: ["x"] } }, tmpDir);
    const s = await loadSettings(tmpDir);
    expect((s as Record<string, unknown>).someOtherField).toBe(true);
    expect(s.permissions?.allow).toEqual(["x"]);
  });
});
