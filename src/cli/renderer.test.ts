import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  COMPACT_TOOLS,
  MarkdownStreamRenderer,
  toolStyle,
  formatToolArgs,
  compactArg,
  summariseResult,
  printToolCall,
  printToolResult,
  printToolCallCompact,
  printToolResultCompact,
  printEditDiff,
  printError,
  printInfo,
  printSkillActivated,
} from "./renderer.js";

// Strip ANSI escape codes so assertions aren't brittle against colour changes
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("COMPACT_TOOLS", () => {
  it("includes read, glob, grep", () => {
    expect(COMPACT_TOOLS.has("read")).toBe(true);
    expect(COMPACT_TOOLS.has("glob")).toBe(true);
    expect(COMPACT_TOOLS.has("grep")).toBe(true);
  });

  it("does not include bash, write, edit", () => {
    expect(COMPACT_TOOLS.has("bash")).toBe(false);
    expect(COMPACT_TOOLS.has("write")).toBe(false);
    expect(COMPACT_TOOLS.has("edit")).toBe(false);
  });
});

describe("toolStyle", () => {
  it("returns magenta + ❯ for bash", () => {
    const { color, icon } = toolStyle("bash");
    expect(color).toBe("magenta");
    expect(icon).toBe("❯");
  });

  it("returns yellow + ✎ for write", () => {
    const { color, icon } = toolStyle("write");
    expect(color).toBe("yellow");
    expect(icon).toBe("✎");
  });

  it("returns yellow + ✎ for edit", () => {
    const { color, icon } = toolStyle("edit");
    expect(color).toBe("yellow");
    expect(icon).toBe("✎");
  });

  it("returns cyan + ⟳ for unknown tools", () => {
    const { color, icon } = toolStyle("read");
    expect(color).toBe("cyan");
    expect(icon).toBe("⟳");
  });
});

describe("formatToolArgs", () => {
  it("returns file_path only for edit tool", () => {
    const result = stripAnsi(
      formatToolArgs("edit", {
        file_path: "src/foo.ts",
        old_string: "x",
        new_string: "y",
      }),
    );
    expect(result).toBe("src/foo.ts");
  });

  it("extracts file_path as primary arg", () => {
    const result = stripAnsi(formatToolArgs("read", { file_path: "src/bar.ts" }));
    expect(result).toBe("src/bar.ts");
  });

  it("extracts pattern as primary arg", () => {
    const result = stripAnsi(formatToolArgs("grep", { pattern: "TODO", path: "src/" }));
    expect(result).toContain("TODO");
  });

  it("extracts command as primary arg for bash", () => {
    const result = stripAnsi(formatToolArgs("bash", { command: "ls -la" }));
    expect(result).toBe("ls -la");
  });

  it("appends extra args after the primary arg", () => {
    const result = stripAnsi(
      formatToolArgs("grep", { pattern: "TODO", path: "src/", case_sensitive: false }),
    );
    expect(result).toContain("TODO");
    expect(result).toContain("case_sensitive");
  });

  it("falls back to JSON for args with no recognised primary key", () => {
    const result = stripAnsi(formatToolArgs("custom", { foo: "bar" }));
    expect(result).toContain("foo");
  });
});

describe("compactArg", () => {
  it("returns file_path when present", () => {
    const result = stripAnsi(compactArg({ file_path: "src/foo.ts" }));
    expect(result).toBe("src/foo.ts");
  });

  it("prefers file_path over pattern", () => {
    const result = stripAnsi(compactArg({ file_path: "src/foo.ts", pattern: "*.ts" }));
    expect(result).toBe("src/foo.ts");
  });

  it("falls back to pattern when no file_path or path", () => {
    const result = stripAnsi(compactArg({ pattern: "**/*.ts" }));
    expect(result).toBe("**/*.ts");
  });

  it("falls back to JSON for unknown args", () => {
    const result = stripAnsi(compactArg({ query: "hello" }));
    expect(result).toContain("query");
  });
});

describe("summariseResult", () => {
  describe("read", () => {
    it("counts lines correctly", () => {
      const result = stripAnsi(summariseResult("read", "line1\nline2\nline3"));
      expect(result).toContain("3 lines");
    });

    it("shows first line as file path preview", () => {
      const result = stripAnsi(summariseResult("read", "src/foo.ts\nconst x = 1;"));
      expect(result).toContain("src/foo.ts");
    });

    it("handles single line", () => {
      const result = stripAnsi(summariseResult("read", "only one line"));
      expect(result).toContain("1 lines");
    });

    it("handles empty result", () => {
      const result = stripAnsi(summariseResult("read", ""));
      expect(result).toContain("1 lines"); // "".split("\n") has length 1
    });
  });

  describe("glob", () => {
    it("counts files correctly", () => {
      const result = stripAnsi(summariseResult("glob", "a.ts\nb.ts\nc.ts"));
      expect(result).toContain("3 files");
    });

    it("uses singular for one file", () => {
      const result = stripAnsi(summariseResult("glob", "a.ts"));
      expect(result).toContain("1 file");
      expect(result).not.toContain("files");
    });

    it("returns 0 files for empty result", () => {
      const result = stripAnsi(summariseResult("glob", ""));
      expect(result).toContain("0 files");
    });
  });

  describe("grep", () => {
    it("counts matches correctly", () => {
      const result = stripAnsi(summariseResult("grep", "match1\nmatch2"));
      expect(result).toContain("2 matches");
    });

    it("uses singular for one match", () => {
      const result = stripAnsi(summariseResult("grep", "one match"));
      expect(result).toContain("1 match");
      expect(result).not.toContain("matches");
    });

    it("returns 0 matches for empty result", () => {
      const result = stripAnsi(summariseResult("grep", ""));
      expect(result).toContain("0 matches");
    });
  });

  describe("bash", () => {
    it("shows first line of output", () => {
      const result = stripAnsi(summariseResult("bash", "58°F partly cloudy\nextra line"));
      expect(result).toContain("58°F partly cloudy");
      expect(result).not.toContain("extra line");
    });

    it("truncates long first lines at 80 chars", () => {
      const long = "x".repeat(100);
      const result = stripAnsi(summariseResult("bash", long));
      expect(result.length).toBeLessThan(120); // name padding + 80 char preview + overhead
    });
  });

  describe("write", () => {
    it("returns 'written' regardless of result content", () => {
      const result = stripAnsi(summariseResult("write", "anything"));
      expect(result).toContain("written");
    });
  });

  describe("unknown tool", () => {
    it("shows a flattened preview of the result", () => {
      const result = stripAnsi(summariseResult("custom", "line1\nline2"));
      expect(result).toContain("line1");
      expect(result).toContain("line2");
    });

    it("truncates at 100 chars", () => {
      const long = "x".repeat(200);
      const result = stripAnsi(summariseResult("custom", long));
      // name (padded to 6) + preview (100) + possible ANSI = reasonable bound
      expect(result.length).toBeLessThan(120);
    });
  });
});

describe("MarkdownStreamRenderer", () => {
  let stdoutOutput: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;

  beforeEach(() => {
    stdoutOutput = [];
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  const stdout = () => stripAnsi(stdoutOutput.join(""));

  it("does not flush before a paragraph boundary", () => {
    const r = new MarkdownStreamRenderer();
    r.push("hello world");
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("flushes a complete paragraph on \\n\\n", () => {
    const r = new MarkdownStreamRenderer();
    r.push("hello world\n\n");
    expect(stdoutSpy).toHaveBeenCalled();
    expect(stdout()).toContain("hello world");
  });

  it("flushes multiple paragraphs in order", () => {
    const r = new MarkdownStreamRenderer();
    r.push("first\n\nsecond\n\n");
    const out = stdout();
    expect(out.indexOf("first")).toBeLessThan(out.indexOf("second"));
  });

  it("does not flush on \\n\\n inside a code fence", () => {
    const r = new MarkdownStreamRenderer();
    r.push("```\ncode\n\nstill inside fence");
    // one ``` seen → inside fence → no flush despite blank line
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("flushes after the closing code fence", () => {
    const r = new MarkdownStreamRenderer();
    r.push("```\ncode\n\nstill inside\n```\n\n");
    expect(stdoutSpy).toHaveBeenCalled();
    expect(stdout()).toContain("code");
  });

  it("flush() renders remaining buffered text", () => {
    const r = new MarkdownStreamRenderer();
    r.push("trailing paragraph");
    expect(stdoutSpy).not.toHaveBeenCalled();
    r.flush();
    expect(stdoutSpy).toHaveBeenCalled();
    expect(stdout()).toContain("trailing paragraph");
  });

  it("flush() writes a trailing newline even when buffer is empty", () => {
    const r = new MarkdownStreamRenderer();
    r.flush();
    expect(stdout()).toContain("\n");
  });

  it("handles chunks that split across a paragraph boundary", () => {
    const r = new MarkdownStreamRenderer();
    r.push("para one\n");
    expect(stdoutSpy).not.toHaveBeenCalled();
    r.push("\npara two");
    // boundary \n\n now complete — first para should have flushed
    expect(stdoutSpy).toHaveBeenCalled();
    expect(stdout()).toContain("para one");
  });

  it("renders bold — strips ** markers from output", () => {
    const r = new MarkdownStreamRenderer();
    r.push("**bold text**\n\n");
    const out = stdout();
    expect(out).toContain("bold text");
    expect(out).not.toContain("**");
  });

  it("renders heading — outputs plain text, not HTML", () => {
    const r = new MarkdownStreamRenderer();
    r.push("# My Heading\n\n");
    const out = stdout();
    expect(out).toContain("My Heading");
    // marked without the terminal renderer would produce <h1>...</h1>;
    // the absence of HTML tags confirms TerminalRenderer is active
    expect(out).not.toContain("<h1>");
    expect(out).not.toContain("</h1>");
  });

  it("renders inline code — strips backtick markers from output", () => {
    const r = new MarkdownStreamRenderer();
    r.push("Use `someFunction()` here\n\n");
    const out = stdout();
    expect(out).toContain("someFunction()");
    expect(out).not.toContain("`someFunction()`");
  });

  it("renders bullet list — strips * markers from output", () => {
    const r = new MarkdownStreamRenderer();
    r.push("* item one\n* item two\n\n");
    const out = stdout();
    expect(out).toContain("item one");
    expect(out).toContain("item two");
    expect(out).not.toMatch(/^\* item/m);
  });
});

describe("print functions write to stderr/stdout", () => {
  let stderrOutput: string[];
  let stdoutOutput: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _stdoutSpy: any;

  beforeEach(() => {
    stderrOutput = [];
    stdoutOutput = [];
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrOutput.push(String(chunk));
      return true;
    });
    _stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    _stdoutSpy.mockRestore();
  });

  const stderr = () => stripAnsi(stderrOutput.join(""));

  it("printToolCall writes to stderr", () => {
    printToolCall("bash", { command: "ls" });
    expect(stderrSpy).toHaveBeenCalled();
    const output = stripAnsi(stderr());
    expect(output).toContain("bash");
  });

  it("printToolResult skips edit tool", () => {
    printToolResult("edit", "anything");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("printToolResult writes summary for bash", () => {
    printToolResult("bash", "hello world");
    const output = stripAnsi(stderr());
    expect(output).toContain("✓");
    expect(output).toContain("hello world");
  });

  it("printToolCallCompact writes ○ line to stderr", () => {
    printToolCallCompact("read", { file_path: "src/foo.ts" });
    const output = stripAnsi(stderr());
    expect(output).toContain("○");
    expect(output).toContain("read");
    expect(output).toContain("src/foo.ts");
  });

  it("printToolResultCompact writes ✓ line to stderr", () => {
    printToolResultCompact("glob", "a.ts\nb.ts");
    const output = stripAnsi(stderr());
    expect(output).toContain("✓");
    expect(output).toContain("2 files");
  });

  it("printEditDiff writes + and - lines to stderr", () => {
    printEditDiff("old content\n", "new content\n", "src/foo.ts");
    const output = stderr();
    expect(output).toContain("-old content");
    expect(output).toContain("+new content");
  });

  it("printError writes to stderr", () => {
    printError("something went wrong");
    const output = stripAnsi(stderr());
    expect(output).toContain("Error: something went wrong");
  });

  it("printInfo writes to stderr", () => {
    printInfo("some info");
    const output = stripAnsi(stderr());
    expect(output).toContain("some info");
  });

  it("printSkillActivated writes to stderr", () => {
    printSkillActivated("commit");
    const output = stripAnsi(stderr());
    expect(output).toContain("skill activated: commit");
  });
});
