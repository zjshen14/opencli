import { describe, it, expect, afterEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

// Isolate history writes from the real ~/.opencli
const tmpHome = join(os.tmpdir(), `opencli-input-test-${Date.now()}`);
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => tmpHome }, homedir: () => tmpHome };
});

// Import after mock so AGENT_DIR resolves to tmpHome.
// All input.ts exports use the dynamic import to avoid static-import hoisting
// (which would trigger homedir() before tmpHome is initialized).
const {
  loadHistory,
  saveHistory,
  insertAtCursor,
  deleteBeforeCursor,
  deleteWordBeforeCursor,
  renderSelectOptions,
} = await import("./input.js");

describe("insertAtCursor", () => {
  it("appends when cursor is at end", () => {
    const result = insertAtCursor("hello", 5, "!");
    expect(result).toEqual({ input: "hello!", cursorPos: 6 });
  });

  it("prepends when cursor is at start", () => {
    const result = insertAtCursor("world", 0, "!");
    expect(result).toEqual({ input: "!world", cursorPos: 1 });
  });

  it("inserts in the middle", () => {
    const result = insertAtCursor("helo", 3, "l");
    expect(result).toEqual({ input: "hello", cursorPos: 4 });
  });

  it("handles insertion into empty string", () => {
    const result = insertAtCursor("", 0, "x");
    expect(result).toEqual({ input: "x", cursorPos: 1 });
  });
});

describe("deleteBeforeCursor", () => {
  it("deletes the character immediately before cursor", () => {
    const result = deleteBeforeCursor("hello", 5);
    expect(result).toEqual({ input: "hell", cursorPos: 4 });
  });

  it("deletes a middle character", () => {
    const result = deleteBeforeCursor("hello", 3);
    expect(result).toEqual({ input: "helo", cursorPos: 2 });
  });

  it("is a no-op when cursor is at start", () => {
    const result = deleteBeforeCursor("hello", 0);
    expect(result).toEqual({ input: "hello", cursorPos: 0 });
  });

  it("is a no-op on empty string", () => {
    const result = deleteBeforeCursor("", 0);
    expect(result).toEqual({ input: "", cursorPos: 0 });
  });
});

describe("deleteWordBeforeCursor", () => {
  it("deletes the last word when cursor is at end", () => {
    const result = deleteWordBeforeCursor("hello world", 11);
    expect(result).toEqual({ input: "hello ", cursorPos: 6 });
  });

  it("clears everything when there is only one word", () => {
    const result = deleteWordBeforeCursor("hello", 5);
    expect(result).toEqual({ input: "", cursorPos: 0 });
  });

  it("only deletes word before cursor, leaving text after cursor intact", () => {
    const result = deleteWordBeforeCursor("hello world", 5);
    expect(result).toEqual({ input: " world", cursorPos: 0 });
  });

  it("trims trailing spaces before deleting the word", () => {
    const result = deleteWordBeforeCursor("hello   ", 8);
    expect(result).toEqual({ input: "", cursorPos: 0 });
  });

  it("is a no-op on empty string", () => {
    const result = deleteWordBeforeCursor("", 0);
    expect(result).toEqual({ input: "", cursorPos: 0 });
  });

  it("deletes a middle word when cursor is mid-string", () => {
    const result = deleteWordBeforeCursor("foo bar baz", 7);
    expect(result).toEqual({ input: "foo  baz", cursorPos: 4 });
  });
});

describe("renderSelectOptions", () => {
  const opts = [
    { key: "a", label: "Approve" },
    { key: "e", label: "Edit" },
    { key: "c", label: "Cancel" },
  ];

  it("contains the arrow marker only for the selected item", () => {
    const out = renderSelectOptions(opts, 1);
    const lines = out.split("\n").filter(Boolean);
    // strip ANSI codes for assertions
    // eslint-disable-next-line no-control-regex
    const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    expect(plain[0]).not.toContain("›");
    expect(plain[1]).toContain("›");
    expect(plain[2]).not.toContain("›");
  });

  it("includes every option label and key", () => {
    const out = renderSelectOptions(opts, 0);
    // eslint-disable-next-line no-control-regex
    const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("Approve");
    expect(plain).toContain("[a]");
    expect(plain).toContain("Edit");
    expect(plain).toContain("[e]");
    expect(plain).toContain("Cancel");
    expect(plain).toContain("[c]");
  });

  it("produces exactly one line per option", () => {
    const out = renderSelectOptions(opts, 0);
    const lines = out.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
  });

  it("keeps selection within bounds at first and last index", () => {
    const first = renderSelectOptions(opts, 0);
    const last = renderSelectOptions(opts, opts.length - 1);
    // eslint-disable-next-line no-control-regex
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    expect(strip(first).split("\n")[0]).toContain("›");
    expect(strip(last).split("\n")[2]).toContain("›");
  });
});

describe("per-CWD history", () => {
  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("loadHistory returns [] when no history file exists", async () => {
    const history = await loadHistory("/some/new/project");
    expect(history).toEqual([]);
  });

  it("saveHistory + loadHistory round-trips entries in the same CWD", async () => {
    const cwd = "/project/alpha";
    await saveHistory(["second", "first"], cwd);
    const loaded = await loadHistory(cwd);
    expect(loaded).toEqual(["second", "first"]);
  });

  it("histories for different CWDs are independent", async () => {
    await saveHistory(["alpha-cmd"], "/project/alpha");
    await saveHistory(["beta-cmd"], "/project/beta");
    const alpha = await loadHistory("/project/alpha");
    const beta = await loadHistory("/project/beta");
    expect(alpha).toEqual(["alpha-cmd"]);
    expect(beta).toEqual(["beta-cmd"]);
  });

  it("caps saved history at MAX_HISTORY (500) entries", async () => {
    const cwd = "/project/cap";
    const entries = Array.from({ length: 600 }, (_, i) => `cmd-${i}`);
    await saveHistory(entries, cwd);
    const loaded = await loadHistory(cwd);
    expect(loaded.length).toBe(500);
  });
});
