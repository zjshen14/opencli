import type { Tool } from "./base.js";
import type { ToolResult } from "../providers/types.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: Tool[]): void {
    for (const tool of tools) this.register(tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  all(): Tool[] {
    return Array.from(this.tools.values());
  }

  async execute(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, output: "", error: `Unknown tool: ${name}` };
    }
    try {
      return await tool.execute(params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: message };
    }
  }
}
