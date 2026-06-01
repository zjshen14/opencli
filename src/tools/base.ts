import type { ToolResult } from "../providers/types.js";

export interface JSONSchema {
  type: string;
  description?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  enum?: string[];
}

/** Minimal interface for invoking tools by name — used in ToolExecutionContext to avoid circular imports. */
export interface ToolRunner {
  execute(name: string, params: Record<string, unknown>): Promise<ToolResult>;
}

/** Context passed to a tool's execute() — gives composed tools a way to call
 *  sub-tools by name. Optional because tools may also be invoked directly in
 *  tests. The registry always populates it when invoking a tool via
 *  `ToolRegistry.execute()`. */
export interface ToolExecutionContext {
  registry: ToolRunner;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  /** true = safe in plan mode (read-only); false/undefined = write tool (blocked in plan mode) */
  readonly?: boolean;
  execute: (params: Record<string, unknown>, ctx?: ToolExecutionContext) => Promise<ToolResult>;
  requiresConfirmation?: (args: Record<string, unknown>) => boolean;
  /** Return an error message string if params are invalid, or null if valid. */
  validate?: (params: Record<string, unknown>) => string | null;
  /** When true, the executor middle-truncates output that exceeds MAX_TOOL_OUTPUT. */
  truncateOutput?: boolean;
  /** Names of sub-tools this tool delegates to internally via ToolExecutionContext.
   *  Used by ToolRegistry to enforce a safety invariant: a composed tool may only
   *  delegate to sub-tools that themselves require confirmation if the composed
   *  tool sets `singleConfirmation: true` (so the user is prompted once for the
   *  composite operation rather than skipping confirmation entirely). */
  composedOf?: string[];
  /** When true, the parent tool's confirmation is treated as covering every
   *  sub-tool it invokes via ctx.registry. Required to compose any sub-tool
   *  that has its own requiresConfirmation predicate. Note: this controls
   *  CONFIRMATION semantics only — failures inside the composed operation do
   *  NOT roll back; the snapshot/rewind system handles undo separately. */
  singleConfirmation?: boolean;
}
