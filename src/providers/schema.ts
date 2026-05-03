import type { Tool } from "../tools/base.js";
import type { ToolDefinition } from "./types.js";

export function toolToDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown as Record<string, unknown>,
  };
}

export const activateSkillDefinition: ToolDefinition = {
  name: "activate_skill",
  description:
    "Activate a skill to load its instructions into the conversation context. Use this when a user's request matches a known skill.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The name of the skill to activate",
      },
    },
    required: ["name"],
  },
};
