import { describe, it, expect } from "vitest";
import { toolToDefinition, activateSkillDefinition } from "./schema.js";
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

describe("toolToDefinition", () => {
  it("preserves name and description", () => {
    const def = toolToDefinition(simpleTool);
    expect(def.name).toBe("read");
    expect(def.description).toBe("Read a file");
  });

  it("passes parameters through as plain JSONSchema (lowercase types)", () => {
    const def = toolToDefinition(simpleTool);
    const params = def.parameters as Record<string, unknown>;
    expect(params.type).toBe("object");
    const props = params.properties as Record<string, Record<string, unknown>>;
    expect(props.file_path.type).toBe("string");
    expect(props.offset.type).toBe("number");
  });

  it("preserves required fields", () => {
    const def = toolToDefinition(simpleTool);
    expect((def.parameters as Record<string, unknown>).required).toEqual(["file_path"]);
  });

  it("preserves property descriptions", () => {
    const def = toolToDefinition(simpleTool);
    const props = (def.parameters as Record<string, Record<string, unknown>>).properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.file_path.description).toBe("Path to the file");
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
    const def = toolToDefinition(tool);
    const props = (def.parameters as Record<string, unknown>).properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.tags.type).toBe("array");
    expect((props.tags.items as Record<string, unknown>).type).toBe("string");
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
    const def = toolToDefinition(tool);
    const props = (def.parameters as Record<string, unknown>).properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.mode.enum).toEqual(["fast", "slow"]);
  });
});

describe("activateSkillDefinition", () => {
  it("has the correct name", () => {
    expect(activateSkillDefinition.name).toBe("activate_skill");
  });

  it("requires the name parameter", () => {
    expect((activateSkillDefinition.parameters as Record<string, unknown>).required).toContain(
      "name",
    );
  });
});
