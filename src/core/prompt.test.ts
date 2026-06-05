import { describe, it, expect, afterEach } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSystemInstruction,
  DEFAULT_SYSTEM_INSTRUCTION,
  getGitContext,
  buildReminder,
  buildPeriodicReminder,
  PERIODIC_REMINDER_INTERVAL,
  renderSystemInstruction,
  buildPlanSuffix,
} from "./prompt.js";

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

describe("buildReminder", () => {
  it("returns empty string for read-only tool calls", () => {
    const calls = [
      { name: "read", args: {} },
      { name: "glob", args: {} },
      { name: "grep", args: {} },
    ];
    expect(buildReminder(calls)).toBe("");
  });

  it("fires test reminder after edit call", () => {
    const calls = [{ name: "edit", args: { file_path: "foo.ts" } }];
    const reminder = buildReminder(calls);
    expect(reminder).toContain("verify the change works");
  });

  it("fires test reminder after write call", () => {
    const calls = [{ name: "write", args: { file_path: "foo.ts" } }];
    expect(buildReminder(calls)).toContain("verify the change works");
  });

  it("fires test reminder after multi_edit call", () => {
    const calls = [{ name: "multi_edit", args: { file_path: "foo.ts", edits: [] } }];
    expect(buildReminder(calls)).toContain("verify the change works");
    expect(buildReminder(calls)).toContain("don't add features");
  });

  it("fires git reminder only when bash command includes git", () => {
    const gitCall = [{ name: "bash", args: { command: "git status" } }];
    const nonGitCall = [{ name: "bash", args: { command: "npm test" } }];
    expect(buildReminder(gitCall)).toContain("never commit or push");
    expect(buildReminder(nonGitCall)).not.toContain("never commit or push");
  });

  it("combines multiple relevant reminders in one block", () => {
    const calls = [
      { name: "edit", args: {} },
      { name: "bash", args: { command: "git diff" } },
    ];
    const reminder = buildReminder(calls);
    expect(reminder).toContain("verify the change works");
    expect(reminder).toContain("never commit or push");
    // Single [reminder: ...] block
    expect(reminder.split("[reminder:").length).toBe(2);
  });

  it("does not repeat a reminder that has already fired in the same run", () => {
    const calls = [{ name: "edit", args: {} }];
    const firedReminders = new Set<string>();
    const first = buildReminder(calls, firedReminders);
    const second = buildReminder(calls, firedReminders);
    expect(first).toContain("verify the change works");
    expect(second).toBe("");
  });

  it("without firedReminders set, reminders fire on every call (backward-compatible)", () => {
    const calls = [{ name: "edit", args: {} }];
    expect(buildReminder(calls)).toContain("verify the change works");
    expect(buildReminder(calls)).toContain("verify the change works");
  });
});

describe("buildPeriodicReminder", () => {
  it("returns empty string for turn 0", () => {
    expect(buildPeriodicReminder(0)).toBe("");
  });

  it("returns empty string for turns that are not multiples of the interval", () => {
    for (let t = 1; t < PERIODIC_REMINDER_INTERVAL; t++) {
      expect(buildPeriodicReminder(t)).toBe("");
    }
  });

  it("returns a [reminder: ...] block at each multiple of the interval", () => {
    for (const t of [PERIODIC_REMINDER_INTERVAL, PERIODIC_REMINDER_INTERVAL * 2]) {
      const r = buildPeriodicReminder(t);
      expect(r).toContain("[reminder:");
      expect(r).toContain("commit only when explicitly asked");
      expect(r).toContain("run tests after changes");
    }
  });
});

describe("renderSystemInstruction", () => {
  const template =
    "cwd={CWD} tmp={SESSION_TMP} git={GIT_CONTEXT}skills={SKILL_CATALOG}tools={TOOL_CATALOG}";

  it("substitutes all placeholders", () => {
    const result = renderSystemInstruction(template, {
      cwd: "/my/project",
      tmpDir: "/tmp/session",
      tools: [],
      gitContext: "",
    });
    expect(result).toContain("cwd=/my/project");
    expect(result).toContain("tmp=/tmp/session");
  });

  it("builds tool catalog from provided tools", () => {
    const result = renderSystemInstruction(template, {
      cwd: "/p",
      tmpDir: "/t",
      tools: [
        { name: "read", description: "Read a file", parameters: {} },
        {
          name: "edit",
          description: "Edit a file",
          parameters: {
            properties: {
              file_path: { type: "string", description: "Path to file" },
              old_string: { type: "string", description: "String to replace" },
            },
            required: ["file_path", "old_string"],
          },
        },
      ],
      gitContext: "",
    });
    expect(result).toContain("## Available Tools");
    expect(result).toContain("### read");
    expect(result).toContain("Read a file");
    expect(result).toContain("### edit");
    expect(result).toContain("file_path (required): Path to file");
    expect(result).toContain("old_string (required): String to replace");
  });

  it("omits tool catalog section when no tools provided", () => {
    const result = renderSystemInstruction(template, {
      cwd: "/p",
      tmpDir: "/t",
      tools: [],
      gitContext: "",
    });
    expect(result).not.toContain("## Available Tools");
    expect(result).toContain("tools=");
  });

  it("appends git context with trailing newlines when present", () => {
    const result = renderSystemInstruction(template, {
      cwd: "/p",
      tmpDir: "/t",
      tools: [],
      gitContext: "## Repository\nBranch: main",
    });
    expect(result).toContain("## Repository");
  });

  it("injects skill catalog when provided", () => {
    const result = renderSystemInstruction(template, {
      cwd: "/p",
      tmpDir: "/t",
      tools: [],
      gitContext: "",
      skillCatalog: "## Available Skills\n- commit: Draft a git commit",
    });
    expect(result).toContain("## Available Skills");
    expect(result).toContain("- commit: Draft a git commit");
  });

  it("leaves SKILL_CATALOG placeholder empty when skillCatalog is absent", () => {
    const result = renderSystemInstruction(template, {
      cwd: "/p",
      tmpDir: "/t",
      tools: [],
      gitContext: "",
    });
    expect(result).not.toContain("{SKILL_CATALOG}");
    expect(result).toContain("skills=");
  });
});

describe("buildPlanSuffix", () => {
  it("includes allowed tool names as backtick list", () => {
    const suffix = buildPlanSuffix(new Set(["read", "glob", "grep", "activate_skill"]));
    expect(suffix).toContain("`read`");
    expect(suffix).toContain("`glob`");
    expect(suffix).toContain("`grep`");
  });

  it("excludes activate_skill from the visible tool list", () => {
    const suffix = buildPlanSuffix(new Set(["read", "activate_skill"]));
    expect(suffix).not.toContain("`activate_skill`");
  });

  it("contains Plan Mode header and output format", () => {
    const suffix = buildPlanSuffix(new Set(["read"]));
    expect(suffix).toContain("## Plan Mode");
    expect(suffix).toContain("## Plan:");
    expect(suffix).toContain("Do NOT begin execution");
  });

  it("reflects new tools added to the set without code changes", () => {
    const suffix = buildPlanSuffix(new Set(["read", "new_tool"]));
    expect(suffix).toContain("`new_tool`");
  });
});
