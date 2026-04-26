import { describe, it, expect } from "vitest";
import { thinkTool } from "./think.js";

describe("thinkTool", () => {
  it("has the correct name and description", () => {
    expect(thinkTool.name).toBe("think");
    expect(thinkTool.description).toContain("reason privately");
  });

  it("requires a thought parameter", () => {
    expect(thinkTool.parameters.required).toContain("thought");
  });

  it("execute returns success with empty output", async () => {
    const result = await thinkTool.execute({ thought: "Let me consider the options…" });
    expect(result.success).toBe(true);
    expect(result.output).toBe("");
    expect(result.error).toBeUndefined();
  });

  it("execute ignores the thought content (no-op)", async () => {
    const result = await thinkTool.execute({ thought: "" });
    expect(result.success).toBe(true);
    expect(result.output).toBe("");
  });
});
