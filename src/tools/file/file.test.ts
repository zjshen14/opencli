import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, mkdtemp, rm, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { multiEditTool } from "./multi-edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { ToolRegistry } from "../registry.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `opencli-test-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// --- read ---

describe("readTool", () => {
  it("reads a file and returns numbered lines", async () => {
    await writeFile(join(tmpDir, "hello.txt"), "line1\nline2\nline3");
    const result = await readTool.execute({ file_path: join(tmpDir, "hello.txt") });
    expect(result.success).toBe(true);
    expect(result.output).toContain("1\tline1");
    expect(result.output).toContain("2\tline2");
    expect(result.output).toContain("3\tline3");
  });

  it("respects offset and limit", async () => {
    await writeFile(join(tmpDir, "f.txt"), "a\nb\nc\nd\ne");
    const result = await readTool.execute({
      file_path: join(tmpDir, "f.txt"),
      offset: 2,
      limit: 2,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("2\tb");
    expect(result.output).toContain("3\tc");
    expect(result.output).not.toContain("4\td");
  });

  it("returns error for missing file", async () => {
    const result = await readTool.execute({ file_path: join(tmpDir, "nonexistent.txt") });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// --- write ---

describe("writeTool", () => {
  it("creates a new file", async () => {
    const path = join(tmpDir, "new.txt");
    const result = await writeTool.execute({ file_path: path, content: "hello" });
    expect(result.success).toBe(true);
    const read = await readTool.execute({ file_path: path });
    expect(read.output).toContain("hello");
  });

  it("overwrites an existing file", async () => {
    const path = join(tmpDir, "existing.txt");
    await writeFile(path, "old content");
    await writeTool.execute({ file_path: path, content: "new content" });
    const read = await readTool.execute({ file_path: path });
    expect(read.output).toContain("new content");
    expect(read.output).not.toContain("old content");
  });

  it("creates missing parent directories", async () => {
    const path = join(tmpDir, "a", "b", "c.txt");
    const result = await writeTool.execute({ file_path: path, content: "deep" });
    expect(result.success).toBe(true);
  });
});

// --- edit ---

describe("editTool", () => {
  it("replaces a unique string", async () => {
    const path = join(tmpDir, "edit.ts");
    await writeFile(path, `const version = "1.0.0";\n`);
    const result = await editTool.execute({
      file_path: path,
      old_string: '"1.0.0"',
      new_string: '"2.0.0"',
    });
    expect(result.success).toBe(true);
    const read = await readTool.execute({ file_path: path });
    expect(read.output).toContain('"2.0.0"');
    expect(read.output).not.toContain('"1.0.0"');
  });

  it("fails when old_string is not found", async () => {
    const path = join(tmpDir, "edit.ts");
    await writeFile(path, "const x = 1;\n");
    const result = await editTool.execute({
      file_path: path,
      old_string: "not present",
      new_string: "replacement",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it("fails when old_string is ambiguous (appears multiple times)", async () => {
    const path = join(tmpDir, "edit.ts");
    await writeFile(path, "foo\nfoo\n");
    const result = await editTool.execute({
      file_path: path,
      old_string: "foo",
      new_string: "bar",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/2 times/);
  });

  it("fails for missing file", async () => {
    const result = await editTool.execute({
      file_path: join(tmpDir, "ghost.ts"),
      old_string: "x",
      new_string: "y",
    });
    expect(result.success).toBe(false);
  });
});

// --- glob ---

describe("globTool", () => {
  beforeEach(async () => {
    await writeFile(join(tmpDir, "a.ts"), "");
    await writeFile(join(tmpDir, "b.ts"), "");
    await writeFile(join(tmpDir, "c.js"), "");
    await mkdir(join(tmpDir, "sub"), { recursive: true });
    await writeFile(join(tmpDir, "sub", "d.ts"), "");
  });

  it("matches top-level files", async () => {
    const result = await globTool.execute({ pattern: "*.ts", path: tmpDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain("a.ts");
    expect(result.output).toContain("b.ts");
    expect(result.output).not.toContain("c.js");
  });

  it("matches recursively with **", async () => {
    const result = await globTool.execute({ pattern: "**/*.ts", path: tmpDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain("a.ts");
    expect(result.output).toContain("d.ts");
  });

  it("returns (no matches) when nothing matches", async () => {
    const result = await globTool.execute({ pattern: "*.py", path: tmpDir });
    expect(result.success).toBe(true);
    expect(result.output).toBe("(no matches)");
  });
});

// --- grep ---

describe("grepTool", () => {
  beforeEach(async () => {
    await writeFile(join(tmpDir, "a.ts"), `export function foo() {}\nexport function bar() {}`);
    await writeFile(join(tmpDir, "b.ts"), `import { foo } from "./a.js";`);
  });

  it("finds matching lines with file and line number", async () => {
    const result = await grepTool.execute({ pattern: "function", path: tmpDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain("a.ts:1");
    expect(result.output).toContain("a.ts:2");
  });

  it("filters by glob", async () => {
    const result = await grepTool.execute({ pattern: "foo", path: tmpDir, glob: "b.ts" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("b.ts");
    expect(result.output).not.toContain("a.ts");
  });

  it("supports case-insensitive search", async () => {
    await writeFile(join(tmpDir, "c.ts"), "EXPORT function Baz() {}");
    const result = await grepTool.execute({
      pattern: "export",
      path: join(tmpDir, "c.ts"),
      case_insensitive: true,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("EXPORT");
  });

  it("returns (no matches) when nothing matches", async () => {
    const result = await grepTool.execute({ pattern: "zzznomatch", path: tmpDir });
    expect(result.success).toBe(true);
    expect(result.output).toBe("(no matches)");
  });

  it("returns error for invalid regex", async () => {
    const result = await grepTool.execute({ pattern: "[invalid", path: tmpDir });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid regex/);
  });
});

// --- multi_edit ---

describe("multiEditTool", () => {
  let multiEditDir: string;

  // mkdtemp creates a directory with a kernel-allocated random suffix, sidestepping
  // CodeQL's "insecure temporary file" rule that flags fixed names in os.tmpdir().
  beforeEach(async () => {
    multiEditDir = await mkdtemp(join(tmpdir(), "opencli-multi-edit-"));
  });
  afterEach(async () => {
    await rm(multiEditDir, { recursive: true, force: true });
  });

  function makeRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register(editTool);
    registry.register(multiEditTool);
    return registry;
  }

  it("applies multiple edits in order via the registry", async () => {
    const path = join(multiEditDir, "multi.ts");
    await writeFile(path, `const a = 1;\nconst b = 2;\nconst c = 3;\n`);
    const registry = makeRegistry();
    const result = await registry.execute("multi_edit", {
      file_path: path,
      edits: [
        { old_string: "const a = 1;", new_string: "const a = 10;" },
        { old_string: "const b = 2;", new_string: "const b = 20;" },
      ],
    });
    expect(result.success).toBe(true);
    const content = await readFile(path, "utf8");
    expect(content).toContain("const a = 10;");
    expect(content).toContain("const b = 20;");
    expect(content).toContain("const c = 3;");
  });

  it("stops on the first failing edit and returns its error", async () => {
    const path = join(multiEditDir, "stop.ts");
    await writeFile(path, `const x = 1;\n`);
    const registry = makeRegistry();
    const result = await registry.execute("multi_edit", {
      file_path: path,
      edits: [
        { old_string: "not present", new_string: "irrelevant" },
        { old_string: "const x = 1;", new_string: "const x = 99;" },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
    const content = await readFile(path, "utf8");
    expect(content).toContain("const x = 1;");
  });

  it("returns error when called without execution context", async () => {
    const result = await multiEditTool.execute({ file_path: "any.ts", edits: [] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/must be invoked via ToolRegistry/);
  });

  it("reports singleConfirmation and composedOf metadata", () => {
    expect(multiEditTool.singleConfirmation).toBe(true);
    expect(multiEditTool.composedOf).toEqual(["edit"]);
  });
});

// --- requiresConfirmation (GHSA-5v6f-c99j-7m36) ---
// Symlink-following logic itself is unit-tested in paths.test.ts; these assert
// each tool wires requiresConfirmation to the shared guard.

describe("requiresConfirmation guards", () => {
  it("write does not require confirmation for a project file", () => {
    expect(writeTool.requiresConfirmation?.({ file_path: "src/index.ts" })).toBe(false);
  });

  it("write requires confirmation for a path outside cwd", () => {
    expect(writeTool.requiresConfirmation?.({ file_path: join(tmpdir(), "evil.txt") })).toBe(true);
  });

  it("edit requires confirmation for a path outside cwd", () => {
    expect(
      editTool.requiresConfirmation?.({
        file_path: join(tmpdir(), "evil.txt"),
        old_string: "a",
        new_string: "b",
      }),
    ).toBe(true);
  });

  it("multi_edit requires confirmation for a path outside cwd", () => {
    expect(
      multiEditTool.requiresConfirmation?.({ file_path: join(tmpdir(), "evil.txt"), edits: [] }),
    ).toBe(true);
  });

  it("read requires confirmation for a path outside cwd", () => {
    expect(readTool.requiresConfirmation?.({ file_path: join(tmpdir(), "secret") })).toBe(true);
  });

  it("read requires confirmation for credential basenames even inside cwd", () => {
    expect(readTool.requiresConfirmation?.({ file_path: ".env" })).toBe(true);
    expect(readTool.requiresConfirmation?.({ file_path: "id_rsa" })).toBe(true);
    expect(readTool.requiresConfirmation?.({ file_path: ".npmrc" })).toBe(true);
  });

  it("read does not require confirmation for a regular project file", () => {
    expect(readTool.requiresConfirmation?.({ file_path: "src/index.ts" })).toBe(false);
  });

  it("grep requires confirmation for a path outside cwd (read-gate parity, GHSA-5v6f)", () => {
    expect(grepTool.requiresConfirmation?.({ pattern: "x", path: join(tmpdir(), "secret") })).toBe(
      true,
    );
    // defaults to cwd → no prompt
    expect(grepTool.requiresConfirmation?.({ pattern: "x" })).toBe(false);
  });

  it("grep requires confirmation for a credential file path even inside cwd", () => {
    expect(grepTool.requiresConfirmation?.({ pattern: "x", path: ".env" })).toBe(true);
    expect(grepTool.requiresConfirmation?.({ pattern: "x", path: "id_rsa" })).toBe(true);
  });

  it("glob and ls require confirmation for a path outside cwd", () => {
    expect(globTool.requiresConfirmation?.({ pattern: "*", path: join(tmpdir(), "x") })).toBe(true);
    expect(lsTool.requiresConfirmation?.({ path: join(tmpdir(), "x") })).toBe(true);
    // defaults to cwd → no prompt
    expect(globTool.requiresConfirmation?.({ pattern: "*" })).toBe(false);
    expect(lsTool.requiresConfirmation?.({})).toBe(false);
  });
});

// --- walker symlink/depth guards (#300) ---

describe("glob/grep walker DoS guards (#300)", () => {
  it("glob does not hang on a symlink cycle and skips symlinked entries", async () => {
    await writeFile(join(tmpDir, "real.ts"), "export const x = 1;");
    // A directory symlink loop: tmpDir/loop -> tmpDir
    await symlink(tmpDir, join(tmpDir, "loop"));
    // A file symlink (should be skipped, not followed)
    await symlink(join(tmpDir, "real.ts"), join(tmpDir, "link.ts"));
    const result = await globTool.execute({ pattern: "**/*.ts", path: tmpDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain("real.ts");
    // The walker skipped symlinks, so it didn't recurse infinitely or list the link.
    expect(result.output).not.toContain("link.ts");
  });

  it("grep does not hang on a symlink cycle", async () => {
    await writeFile(join(tmpDir, "needle.ts"), "UNIQUE_MARKER_12345");
    await symlink(tmpDir, join(tmpDir, "loopdir"));
    const result = await grepTool.execute({ pattern: "UNIQUE_MARKER_12345", path: tmpDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain("needle.ts");
  }, 15_000);
});
