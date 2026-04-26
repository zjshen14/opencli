import { describe, it, expect, afterEach } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSystemInstruction, DEFAULT_SYSTEM_INSTRUCTION, getGitContext } from "./prompt.js";

afterEach(() => {
  delete process.env.OPENCLI_SYSTEM_MD;
});

describe("loadSystemInstruction", () => {
  it("returns DEFAULT_SYSTEM_INSTRUCTION when OPENCLI_SYSTEM_MD is not set", async () => {
    const result = await loadSystemInstruction();
    expect(result).toBe(DEFAULT_SYSTEM_INSTRUCTION);
  });

  it("loads from file when OPENCLI_SYSTEM_MD is set", async () => {
    const path = join(tmpdir(), `prompt-test-${Date.now()}.md`);
    await writeFile(path, "Custom prompt for testing.");
    process.env.OPENCLI_SYSTEM_MD = path;

    const result = await loadSystemInstruction();
    expect(result).toBe("Custom prompt for testing.");

    await rm(path);
  });

  it("throws when OPENCLI_SYSTEM_MD points to a missing file", async () => {
    process.env.OPENCLI_SYSTEM_MD = "/nonexistent/path/prompt.md";
    await expect(loadSystemInstruction()).rejects.toThrow();
  });
});

describe("getGitContext", () => {
  it("returns a string without throwing", () => {
    const ctx = getGitContext();
    expect(typeof ctx).toBe("string");
  });

  it("returns either empty string or a well-formed Repository section", () => {
    const ctx = getGitContext();
    if (ctx) {
      expect(ctx).toContain("## Repository");
      expect(ctx).toContain("Branch:");
      expect(ctx).toContain("Status:");
    }
  });
});
