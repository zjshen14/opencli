import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expandMentions } from "./mentions.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `opencli-mentions-test-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("expandMentions", () => {
  it("returns input unchanged when no @mentions present", async () => {
    const result = await expandMentions("hello world", tmpDir);
    expect(result).toBe("hello world");
  });

  it("expands a single @file mention with file content", async () => {
    await writeFile(join(tmpDir, "foo.ts"), "export const x = 1;");
    const result = await expandMentions("look at @foo.ts please", tmpDir);
    expect(result).toContain("export const x = 1;");
    expect(result).toContain("// foo.ts");
    expect(result).toContain("look at");
    expect(result).toContain("please");
  });

  it("expands an @mention using a subpath", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src", "bar.ts"), "const y = 2;");
    const result = await expandMentions("review @src/bar.ts", tmpDir);
    expect(result).toContain("const y = 2;");
    expect(result).toContain("// src/bar.ts");
  });

  it("leaves @mention unchanged and warns when file not found", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await expandMentions("check @nonexistent.ts", tmpDir);
    expect(result).toContain("@nonexistent.ts");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("nonexistent.ts"));
  });

  it("leaves non-file-like @mentions unchanged silently", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await expandMentions("ping @alice and fix @TODO", tmpDir);
    expect(result).toBe("ping @alice and fix @TODO");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("expands glob pattern to multiple files", async () => {
    await mkdir(join(tmpDir, "lib"), { recursive: true });
    await writeFile(join(tmpDir, "lib", "a.ts"), "const a = 1;");
    await writeFile(join(tmpDir, "lib", "b.ts"), "const b = 2;");
    const result = await expandMentions("review @lib/*.ts", tmpDir);
    expect(result).toContain("const a = 1;");
    expect(result).toContain("const b = 2;");
  });

  it("leaves glob unchanged when no files match", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await expandMentions("show @src/**/*.xyz", tmpDir);
    expect(result).toContain("@src/**/*.xyz");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("src/**/*.xyz"));
  });

  it("truncates large files at MAX_FILE_CHARS", async () => {
    const bigContent = "x".repeat(60_000);
    await writeFile(join(tmpDir, "big.ts"), bigContent);
    const result = await expandMentions("@big.ts", tmpDir);
    expect(result).toContain("truncated at 50000 chars");
    expect(result).not.toContain("x".repeat(60_000));
  });

  it("handles multiple @mentions in one input", async () => {
    await writeFile(join(tmpDir, "a.ts"), "const a = 1;");
    await writeFile(join(tmpDir, "b.ts"), "const b = 2;");
    const result = await expandMentions("compare @a.ts and @b.ts", tmpDir);
    expect(result).toContain("const a = 1;");
    expect(result).toContain("const b = 2;");
  });
});
