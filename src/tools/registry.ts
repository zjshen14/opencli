import type { Tool, ToolExecutionContext } from "./base.js";
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

  /**
   * Run a tool by name. Performs three checks before invoking the tool's
   * execute() function:
   *
   *  1. Tool exists.
   *  2. Required parameters are present.
   *  3. tool.validate() passes (if defined).
   *
   * Plus one composition-safety check (see #65): if the tool declares
   * `composedOf` sub-tools, and any of those sub-tools has its own
   * `requiresConfirmation` predicate, the composing tool MUST set
   * `singleConfirmation: true`. Otherwise the composed call would bypass the
   * user-confirmation gate (the executor's HITL prompt, the permissions
   * deny/ask rules, plan-mode read-only enforcement) that the sub-tool was
   * designed to trigger.
   *
   * The registry does NOT itself run a user-confirmation prompt — that lives
   * in `src/core/executor.ts`. The composition guard ensures that the only way
   * to invoke a confirmation-gated tool from inside another tool is to wrap it
   * in a `singleConfirmation: true` parent whose own confirmation covers the
   * composite operation.
   */
  async execute(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, output: "", error: `Unknown tool: ${name}` };
    }

    for (const field of tool.parameters.required ?? []) {
      if (params[field] === undefined || params[field] === null) {
        return { success: false, output: "", error: `Missing required parameter: ${field}` };
      }
    }

    const validationError = tool.validate?.(params) ?? null;
    if (validationError !== null) {
      return { success: false, output: "", error: validationError };
    }

    if (tool.composedOf && !tool.singleConfirmation) {
      for (const subName of tool.composedOf) {
        const sub = this.tools.get(subName);
        if (sub?.requiresConfirmation) {
          return {
            success: false,
            output: "",
            error:
              `Tool '${name}' lists '${subName}' in composedOf, but '${subName}' has a ` +
              `requiresConfirmation predicate and '${name}' is not marked ` +
              `singleConfirmation: true. This composition would silently bypass the ` +
              `user-confirmation gate on '${subName}'. Either set singleConfirmation: true ` +
              `on '${name}' (so its own confirmation covers the sub-call) or remove ` +
              `'${subName}' from composedOf.`,
          };
        }
      }
    }

    const ctx: ToolExecutionContext = { registry: this };
    try {
      return await tool.execute(params, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: message };
    }
  }
}
