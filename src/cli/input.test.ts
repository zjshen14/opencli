import { describe, it, expect } from "vitest";
import { insertAtCursor, deleteBeforeCursor, deleteWordBeforeCursor } from "./input.js";

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
