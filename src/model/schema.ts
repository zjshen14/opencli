import type { Tool } from "../tools/base.js";
import type { FunctionDeclaration, Schema } from "@google/genai";

// Converts JSONSchema type strings to Gemini's uppercase TYPE enum values
function convertType(type: string): string {
  return type.toUpperCase();
}

function convertSchema(schema: Record<string, unknown>): Schema {
  const result: Schema = {
    type: convertType(schema.type as string) as Schema["type"],
  };

  if (schema.description) result.description = schema.description as string;
  if (schema.enum) result.enum = schema.enum as string[];

  if (schema.properties) {
    result.properties = {};
    for (const [key, val] of Object.entries(schema.properties as Record<string, unknown>)) {
      result.properties[key] = convertSchema(val as Record<string, unknown>);
    }
  }

  if (schema.items) {
    result.items = convertSchema(schema.items as Record<string, unknown>);
  }

  if (schema.required) result.required = schema.required as string[];

  return result;
}

export function toolToFunctionDeclaration(tool: Tool): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: convertSchema(tool.parameters as unknown as Record<string, unknown>),
  };
}

// The activate_skill function declaration for model-driven skill activation
export const activateSkillDeclaration: FunctionDeclaration = {
  name: "activate_skill",
  description:
    "Activate a skill to load its instructions into the conversation context. Use this when a user's request matches a known skill.",
  parameters: {
    type: "OBJECT" as Schema["type"],
    properties: {
      name: {
        type: "STRING" as Schema["type"],
        description: "The name of the skill to activate",
      },
    },
    required: ["name"],
  },
};
