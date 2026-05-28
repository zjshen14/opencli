import { describe, it, expect } from "vitest";
import { looksLikeActionablePlan } from "./plan.js";

describe("looksLikeActionablePlan", () => {
  it("returns true for numbered steps", () => {
    expect(looksLikeActionablePlan("1. Read the file\n2. Add the function\n3. Run tests")).toBe(
      true,
    );
  });

  it("returns true for indented numbered steps", () => {
    expect(looksLikeActionablePlan("Here is the plan:\n  1. First step\n  2. Second step")).toBe(
      true,
    );
  });

  it("returns true for a ## Plan section header", () => {
    expect(looksLikeActionablePlan("## Plan\nRead and modify the file.")).toBe(true);
  });

  it("returns true for a ## Steps section header", () => {
    expect(looksLikeActionablePlan("## Steps\n- Do this\n- Do that")).toBe(true);
  });

  it("returns true for # Steps (single hash)", () => {
    expect(looksLikeActionablePlan("# Steps\n1. Do something")).toBe(true);
  });

  it("returns true for Step N: heading", () => {
    expect(looksLikeActionablePlan("Step 1: Read the file\nStep 2: Write the output")).toBe(true);
  });

  it("returns false for a plain informational answer", () => {
    expect(
      looksLikeActionablePlan(
        "The src/ directory contains one file: math.ts.\nThe file src/math.ts has 11 lines.",
      ),
    ).toBe(false);
  });

  it("returns false for a single-sentence answer", () => {
    expect(looksLikeActionablePlan("The answer is 42.")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(looksLikeActionablePlan("")).toBe(false);
  });

  it("returns false for prose without step markers", () => {
    expect(
      looksLikeActionablePlan(
        "I have read the file. It contains three functions: add, subtract, and multiply.",
      ),
    ).toBe(false);
  });
});
