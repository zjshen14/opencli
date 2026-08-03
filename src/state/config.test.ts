import { describe, it, expect, afterEach, vi } from "vitest";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We patch homedir to isolate config from the real ~/.opencli
const tmpHome = join(tmpdir(), `opencli-config-test-${Date.now()}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => tmpHome };
});

// Import after mock is set up
const { loadConfig, saveConfig } = await import("./config.js");

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns defaults when no config file exists", async () => {
    const config = await loadConfig();
    expect(config.model).toBe("gemini-3.1-flash-lite-preview");
    expect(config.temperature).toBe(0.7);
    expect(config.historySize).toBe(50);
    expect(config.autoExecute).toBe(false);
  });

  it("merges saved values over defaults", async () => {
    await saveConfig({ model: "gemini-3.1-pro-preview", historySize: 100 });
    const config = await loadConfig();
    expect(config.model).toBe("gemini-3.1-pro-preview");
    expect(config.historySize).toBe(100);
    expect(config.temperature).toBe(0.7); // default preserved
  });

  it("strips prototype-hijacking keys from a crafted config file (#301)", async () => {
    // Write a config that attempts to pollute Object.prototype via __proto__.
    const { writeFile, mkdir } = await import("node:fs/promises");
    const cfgDir = join(tmpHome, ".opencli");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(
      join(cfgDir, "config.json"),
      JSON.stringify({
        __proto__: { polluted: true },
        constructor: { prototype: { polluted2: true } },
        model: "gemini-2.5-flash",
      }),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const before: any = {};
    expect(before.polluted).toBeUndefined(); // sanity: not yet polluted
    const config = await loadConfig();
    // Legitimate field still loaded
    expect(config.model).toBe("gemini-2.5-flash");
    // Prototype was NOT polluted
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).polluted).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).polluted2).toBeUndefined();
  });
});

describe("saveConfig", () => {
  it("persists config to disk", async () => {
    await saveConfig({ model: "gemini-2.5-flash" });
    const config = await loadConfig();
    expect(config.model).toBe("gemini-2.5-flash");
  });

  it("merges partial updates without overwriting other fields", async () => {
    await saveConfig({ model: "gemini-2.5-flash" });
    await saveConfig({ historySize: 25 });
    const config = await loadConfig();
    expect(config.model).toBe("gemini-2.5-flash");
    expect(config.historySize).toBe(25);
  });

  it("writes config file with owner-only permissions (0o600)", async () => {
    await saveConfig({ model: "gemini-2.5-flash" });
    const configFile = join(tmpHome, ".opencli", "config.json");
    const info = await stat(configFile);
    expect(info.mode & 0o777).toBe(0o600);
  });
});
