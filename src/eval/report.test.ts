import { describe, it, expect } from "vitest";
import { formatMatrix } from "./report.js";

const CATEGORIES = { "scenario-a": "bug-fix", "scenario-b": "feature-add" };

describe("formatMatrix", () => {
  it("renders correct column headers", () => {
    const { markdown } = formatMatrix(
      { "scenario-a": { gemini: "pass" } },
      { "scenario-a": "bug-fix" },
      ["gemini"],
    );
    expect(markdown).toContain("gemini");
    expect(markdown).toContain("scenario-a");
  });

  it("shows pass rate row", () => {
    const matrix = {
      "scenario-a": { gemini: "pass", anthropic: "fail" },
      "scenario-b": { gemini: "pass", anthropic: "pass" },
    };
    const { markdown } = formatMatrix(matrix, CATEGORIES, ["gemini", "anthropic"]);
    expect(markdown).toContain("Pass rate");
    expect(markdown).toContain("100%");
    expect(markdown).toContain("50%");
  });

  it("emits 15pp parity warning when threshold breached", () => {
    const matrix = {
      a: { gemini: "pass", anthropic: "fail" },
      b: { gemini: "pass", anthropic: "fail" },
      c: { gemini: "pass", anthropic: "fail" },
      d: { gemini: "pass", anthropic: "pass" },
    };
    const categories = { a: "bug-fix", b: "bug-fix", c: "bug-fix", d: "bug-fix" };
    const { markdown } = formatMatrix(matrix, categories, ["gemini", "anthropic"]);
    expect(markdown).toContain("⚠");
    expect(markdown).toContain("anthropic");
  });

  it("does not emit warning when gap is exactly 15pp", () => {
    const matrix: Record<string, Record<string, string>> = {};
    for (let i = 0; i < 20; i++) {
      matrix[`s${i}`] = { a: "pass", b: i < 17 ? "pass" : "fail" };
    }
    const categories = Object.fromEntries(Object.keys(matrix).map((k) => [k, "bug-fix"]));
    const { markdown } = formatMatrix(matrix, categories, ["a", "b"]);
    expect(markdown).not.toContain("⚠");
  });

  it("json field has correct schema", () => {
    const { json } = formatMatrix(
      { "scenario-a": { gemini: "pass" } },
      { "scenario-a": "bug-fix" },
      ["gemini"],
    );
    expect(json).toHaveProperty("timestamp");
    expect(json).toHaveProperty("providers");
    expect(json).toHaveProperty("scenarios");
    expect(json).toHaveProperty("passRates");
    expect(json.scenarios[0]).toHaveProperty("id", "scenario-a");
    expect(json.scenarios[0]).toHaveProperty("category", "bug-fix");
    expect(json.passRates.gemini).toBe(1);
  });
});
