import type { Tool } from "./base.js";

/**
 * A no-op scratchpad tool that gives the model structured space to reason
 * privately before committing to a real tool call.
 *
 * The thought content is captured in context (so it influences future turns)
 * but is rendered as a dim, collapsed line in the CLI — not highlighted like
 * real tool calls.
 *
 * Reference: https://www.anthropic.com/engineering/claude-think-tool
 */
export const thinkTool: Tool = {
  name: "think",
  description:
    "Use this to reason privately before acting. The output is not shown to the user — " +
    "it is a scratchpad for working through a complex problem before committing to a tool call.",
  parameters: {
    type: "object",
    properties: {
      thought: { type: "string", description: "Your reasoning" },
    },
    required: ["thought"],
  },
  execute: async () => ({ success: true, output: "" }),
};
