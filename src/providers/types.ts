// "model" is used internally; each client translates to its provider's role name ("assistant" for Anthropic)
export type Role = "user" | "model";

// Provider-agnostic tool definition passed to LLMClient.stream(); parameters is plain JSONSchema
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface TextPart {
  type: "text";
  text: string;
}

export interface FunctionCallPart {
  type: "function_call";
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface FunctionResultPart {
  type: "function_result";
  id: string;
  name: string;
  result: string;
}

export type MessagePart = TextPart | FunctionCallPart | FunctionResultPart;

export interface Message {
  role: Role;
  parts: MessagePart[];
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

// Normalized stream event types emitted by all provider clients
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "function_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done" };
