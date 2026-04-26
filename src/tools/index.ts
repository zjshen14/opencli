export { readTool } from "./file/read.js";
export { writeTool } from "./file/write.js";
export { editTool } from "./file/edit.js";
export { globTool } from "./file/glob.js";
export { grepTool } from "./file/grep.js";
export { bashTool } from "./exec/bash.js";
export { thinkTool } from "./think.js";
export { ToolRegistry } from "./registry.js";
export type { Tool } from "./base.js";

import { ToolRegistry } from "./registry.js";
import { readTool } from "./file/read.js";
import { writeTool } from "./file/write.js";
import { editTool } from "./file/edit.js";
import { globTool } from "./file/glob.js";
import { grepTool } from "./file/grep.js";
import { bashTool } from "./exec/bash.js";
import { thinkTool } from "./think.js";
import { hasNativeThinking } from "../model/factory.js";

/**
 * Creates a tool registry with all built-in tools.
 * When a model name is provided, the `think` tool is omitted for models
 * with native thinking/reasoning (e.g. Gemini 2.5+) since their built-in
 * reasoning is cheaper and faster than a tool-call round-trip.
 */
export function createDefaultRegistry(model?: string): ToolRegistry {
  const registry = new ToolRegistry();
  const tools = [readTool, writeTool, editTool, globTool, grepTool, bashTool];

  if (!model || !hasNativeThinking(model)) {
    tools.push(thinkTool);
  }

  registry.registerAll(tools);
  return registry;
}
