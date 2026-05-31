import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { multiEditTool } from "./multi-edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
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
  function makeRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register(editTool);
    registry.register(multiEditTool);
    return registry;
  }

  it("applies multiple edits in order via the registry", async () => {
    const path = join(tmpDir, "multi.ts");
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
    const path = join(tmpDir, "stop.ts");
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
    expect(result.error).toMatch(/execution context/);
  });

  it("reports atomic and composedOf metadata", () => {
    expect(multiEditTool.atomic).toBe(true);
    expect(multiEditTool.composedOf).toEqual(["edit"]);
  });
});
