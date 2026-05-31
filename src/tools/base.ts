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

export interface ToolExecutionContext {
  registry: ToolRunner;
  tmpDir?: string;
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
  /** Names of sub-tools this tool delegates to internally. Informational for the executor. */
  composedOf?: string[];
  /** When true, requiresConfirmation fires once for this tool; sub-tool calls skip confirmation. */
  atomic?: boolean;
}
