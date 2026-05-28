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
  // Gemini thinking models (gemini-3.x, *-thinking) emit a thoughtSignature on
  // every functionCall and require it to be echoed back when the corresponding
  // functionResponse is sent. Persisted in the session JSONL so resumed sessions
  // can reproduce the exact same wire payload as an unbroken session.
  thoughtSignature?: string;
}

export interface FunctionResultPart {
  type: "function_result";
  id: string;
  name: string;
  result: string;
  // Same signature as the paired FunctionCallPart. Set when the result is
  // constructed (executor) or restored (reconstructMessages); echoed by the
  // Gemini provider on the outgoing functionResponse.
  thoughtSignature?: string;
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
  | {
      type: "function_call";
      id: string;
      name: string;
      args: Record<string, unknown>;
      thoughtSignature?: string;
    }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done" };
