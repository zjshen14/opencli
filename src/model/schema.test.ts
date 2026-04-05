import { describe, it, expect } from "vitest";
import { toolToFunctionDeclaration, activateSkillDeclaration } from "./schema.js";
import type { Tool } from "../tools/base.js";

const simpleTool: Tool = {
  name: "read",
  description: "Read a file",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the file" },
      offset: { type: "number" },
    },
    required: ["file_path"],
  },
  execute: async () => ({ success: true, output: "" }),
};

describe("toolToFunctionDeclaration", () => {
  it("preserves name and description", () => {
    const decl = toolToFunctionDeclaration(simpleTool);
    expect(decl.name).toBe("read");
    expect(decl.description).toBe("Read a file");
  });

  it("converts type strings to uppercase", () => {
    const decl = toolToFunctionDeclaration(simpleTool);
    expect(decl.parameters?.type).toBe("OBJECT");
    expect(decl.parameters?.properties?.file_path.type).toBe("STRING");
    expect(decl.parameters?.properties?.offset.type).toBe("NUMBER");
  });

  it("preserves required fields", () => {
    const decl = toolToFunctionDeclaration(simpleTool);
    expect(decl.parameters?.required).toEqual(["file_path"]);
  });

  it("preserves property descriptions", () => {
    const decl = toolToFunctionDeclaration(simpleTool);
    expect(decl.parameters?.properties?.file_path.description).toBe("Path to the file");
  });

  it("handles nested array items", () => {
    const tool: Tool = {
      name: "list",
      description: "List items",
      parameters: {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
        },
      },
      execute: async () => ({ success: true, output: "" }),
    };
    const decl = toolToFunctionDeclaration(tool);
    expect(decl.parameters?.properties?.tags.type).toBe("ARRAY");
    expect(decl.parameters?.properties?.tags.items?.type).toBe("STRING");
  });

  it("handles enum values", () => {
    const tool: Tool = {
      name: "mode",
      description: "Set mode",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["fast", "slow"] },
        },
      },
      execute: async () => ({ success: true, output: "" }),
    };
    const decl = toolToFunctionDeclaration(tool);
    expect(decl.parameters?.properties?.mode.enum).toEqual(["fast", "slow"]);
  });
});

describe("activateSkillDeclaration", () => {
  it("has the correct name", () => {
    expect(activateSkillDeclaration.name).toBe("activate_skill");
  });

  it("requires the name parameter", () => {
    expect(activateSkillDeclaration.parameters?.required).toContain("name");
  });
});
