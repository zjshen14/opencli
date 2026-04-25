import type { Message, StreamEvent, ToolDefinition } from "./types.js";

export interface LLMClient {
  stream(
    messages: Message[],
    systemInstruction: string,
    tools: ToolDefinition[],
  ): AsyncGenerator<StreamEvent>;
}
