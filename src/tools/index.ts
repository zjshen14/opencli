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

export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll([readTool, writeTool, editTool, globTool, grepTool, bashTool, thinkTool]);
  return registry;
}
