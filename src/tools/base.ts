import type { ToolResult } from "../providers/types.js";

export interface JSONSchema {
  type: string;
  description?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  enum?: string[];
}

export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  /** true = safe in plan mode (read-only); false/undefined = write tool (blocked in plan mode) */
  readonly?: boolean;
  execute: (params: Record<string, unknown>) => Promise<ToolResult>;
  requiresConfirmation?: (args: Record<string, unknown>) => boolean;
  /** Return an error message string if params are invalid, or null if valid. */
  validate?: (params: Record<string, unknown>) => string | null;
}
