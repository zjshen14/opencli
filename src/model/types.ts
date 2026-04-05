export type Role = "user" | "model";

export interface TextPart {
  type: "text";
  text: string;
}

export interface FunctionCallPart {
  type: "function_call";
  id: string;
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string; // required by Gemini thinking models
}

export interface FunctionResultPart {
  type: "function_result";
  id: string;
  name: string;
  result: string;
  thoughtSignature?: string; // echoed back from the original function call
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

// Normalized stream event types emitted by the Gemini client
export type StreamEvent =
  | { type: "text"; text: string }
  | {
      type: "function_call";
      id: string;
      name: string;
      args: Record<string, unknown>;
      thoughtSignature?: string;
    }
  | { type: "done" };
