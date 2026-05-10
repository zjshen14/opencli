import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expandMentions } from "./mentions.js";

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `mentions-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("expandMentions", () => {
  it("input with no @tokens is returned unchanged with no warnings", async () => {
    const result = await expandMentions("explain this code please", dir);
    expect(result.expanded).toBe("explain this code please");
    expect(result.warnings).toHaveLength(0);
  });

  it("single @file expands inline at token position", async () => {
    await writeFile(join(dir, "hello.ts"), "const x = 1;\n");
    const result = await expandMentions(`review @hello.ts please`, dir);
    expect(result.warnings).toHaveLength(0);
    expect(result.expanded).toContain("--- @hello.ts ---");
    expect(result.expanded).toContain("const x = 1;");
    expect(result.expanded).toContain("--- end ---");
    expect(result.expanded).toMatch(/^review .+ please$/s);
  });

  it("@nonexistent.ts leaves token unchanged and adds a warning", async () => {
    const result = await expandMentions("check @nonexistent.ts", dir);
    expect(result.expanded).toBe("check @nonexistent.ts");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/nonexistent\.ts.*(not found|ENOENT)/i);
  });

  it("@glob pattern expands to multiple file blocks", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "const a = 1;\n");
    await writeFile(join(dir, "src", "b.ts"), "const b = 2;\n");
    const result = await expandMentions(`review @src/*.ts`, dir);
    expect(result.warnings).toHaveLength(0);
    expect(result.expanded).toContain("const a = 1;");
    expect(result.expanded).toContain("const b = 2;");
  });

  it("@glob with no matches leaves token unchanged and warns", async () => {
    const result = await expandMentions(`review @src/**/*.nonexistent`, dir);
    expect(result.expanded).toBe(`review @src/**/*.nonexistent`);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/no files matched/i);
  });

  it("file exceeding 50 000-char cap is truncated with a note", async () => {
    const big = "x".repeat(60_000);
    await writeFile(join(dir, "big.ts"), big);
    const result = await expandMentions(`@big.ts`, dir);
    expect(result.warnings).toHaveLength(0);
    expect(result.expanded).toContain("truncated at 50000 chars");
    expect(result.expanded.length).toBeLessThan(big.length);
  });

  it("glob hitting 20-file cap warns and returns partial result", async () => {
    // Create 22 files
    for (let i = 0; i < 22; i++) {
      await writeFile(join(dir, `f${i}.ts`), `const f${i} = ${i};\n`);
    }
    const result = await expandMentions(`@*.ts`, dir);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/capped at 20 files/i);
    // Should contain exactly 20 file blocks
    const count = (result.expanded.match(/--- end ---/g) ?? []).length;
    expect(count).toBe(20);
  });

  it("binary file is skipped with a warning", async () => {
    // Write a file with a null byte
    const buf = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x00, 0x6f]);
    await writeFile(join(dir, "binary.bin"), buf);
    const result = await expandMentions(`@binary.bin`, dir);
    expect(result.expanded).toBe(`@binary.bin`);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/binary file/i);
  });

  it("@token in the middle of a sentence expands inline", async () => {
    await writeFile(join(dir, "util.ts"), "export function add() {}\n");
    const result = await expandMentions(`please review @util.ts and fix it`, dir);
    expect(result.warnings).toHaveLength(0);
    expect(result.expanded).toMatch(/^please review .+ and fix it$/s);
    expect(result.expanded).toContain("export function add()");
  });
});
