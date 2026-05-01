import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lsTool } from "./ls.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `opencli-ls-test-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("lsTool", () => {
  it("lists files and directories sorted dirs-first then alpha", async () => {
    await writeFile(join(tmpDir, "b.txt"), "b");
    await writeFile(join(tmpDir, "a.txt"), "a");
    await mkdir(join(tmpDir, "subdir"));
    const result = await lsTool.execute({ path: tmpDir });
    expect(result.success).toBe(true);
    const lines = result.output.split("\n");
    expect(lines[0]).toBe("subdir/");
    expect(lines[1]).toMatch(/^a\.txt/);
    expect(lines[2]).toMatch(/^b\.txt/);
  });

  it("includes file size in bytes", async () => {
    await writeFile(join(tmpDir, "hello.txt"), "hello");
    const result = await lsTool.execute({ path: tmpDir });
    expect(result.output).toContain("5 bytes");
  });

  it("defaults to cwd when path is omitted", async () => {
    const result = await lsTool.execute({});
    expect(result.success).toBe(true);
  });

  it("returns error for non-existent path", async () => {
    const result = await lsTool.execute({ path: join(tmpDir, "no-such-dir") });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns empty message for an empty directory", async () => {
    const empty = join(tmpDir, "empty");
    await mkdir(empty);
    const result = await lsTool.execute({ path: empty });
    expect(result.success).toBe(true);
    expect(result.output).toBe("(empty directory)");
  });
});
