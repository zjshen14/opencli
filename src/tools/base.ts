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
  execute: (params: Record<string, unknown>) => Promise<ToolResult>;
  /** Return true if this call requires interactive user confirmation before execution. */
  requiresConfirmation?: (args: Record<string, unknown>) => boolean;
}
