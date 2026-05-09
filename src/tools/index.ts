export { readTool } from "./file/read.js";
export { writeTool } from "./file/write.js";
export { editTool } from "./file/edit.js";
export { globTool } from "./file/glob.js";
export { grepTool } from "./file/grep.js";
export { lsTool } from "./file/ls.js";
export { createBashTool } from "./exec/bash.js";
export { thinkTool } from "./think.js";
export { webFetchTool } from "./web/fetch.js";
export { todoWriteTool, todoReadTool } from "./task/todo.js";
export { ToolRegistry } from "./registry.js";
export type { Tool } from "./base.js";

import { ToolRegistry } from "./registry.js";
import { readTool } from "./file/read.js";
import { writeTool } from "./file/write.js";
import { editTool } from "./file/edit.js";
import { globTool } from "./file/glob.js";
import { grepTool } from "./file/grep.js";
import { lsTool } from "./file/ls.js";
import { createBashTool } from "./exec/bash.js";
import { thinkTool } from "./think.js";
import { webFetchTool } from "./web/fetch.js";
import { todoWriteTool, todoReadTool } from "./task/todo.js";
import { hasNativeThinking } from "../providers/factory.js";
import { PassthroughRunner } from "./exec/sandbox/passthrough.js";
import type { SandboxRunner } from "./exec/sandbox/types.js";

/**
 * Creates a tool registry with all built-in tools.
 * When a model name is provided, the `think` tool is omitted for models
 * with native thinking/reasoning (e.g. Gemini 2.5+) since their built-in
 * reasoning is cheaper and faster than a tool-call round-trip.
 */
export function createDefaultRegistry(model?: string, runner?: SandboxRunner): ToolRegistry {
  const registry = new ToolRegistry();
  const effectiveRunner = runner ?? new PassthroughRunner("off");
  const tools = [
    readTool,
    writeTool,
    editTool,
    globTool,
    grepTool,
    lsTool,
    createBashTool(effectiveRunner),
    webFetchTool,
    todoWriteTool,
    todoReadTool,
  ];

  if (!model || !hasNativeThinking(model)) {
    tools.push(thinkTool);
  }

  registry.registerAll(tools);
  return registry;
}
