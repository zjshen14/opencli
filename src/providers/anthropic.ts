import Anthropic, { APIError } from "@anthropic-ai/sdk";
import type { LLMClient } from "./client.js";
import type { Message, StreamEvent, ToolDefinition } from "./types.js";
import { withRetry } from "./retry.js";
import { toFriendlyError } from "./errors.js";

const DEFAULT_MAX_TOKENS = 8096;

export class AnthropicClient implements LLMClient {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private temperature: number | undefined;

  constructor(
    apiKey: string,
    model: string,
    maxTokens = DEFAULT_MAX_TOKENS,
    baseUrl?: string,
    temperature?: number,
  ) {
    this.client = new Anthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
    this.model = model;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
  }

  async *stream(
    messages: Message[],
    systemInstruction: string,
    tools: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    const anthropicMessages = messagesToAnthropicParams(messages);
    const anthropicTools = tools.map(definitionToAnthropicTool);

    try {
      yield* withRetry(
        () => this._streamOnce(anthropicMessages, systemInstruction, anthropicTools),
        (err) =>
          err instanceof APIError &&
          err.status !== undefined &&
          [429, 500, 502, 529].includes(err.status),
      );
    } catch (err) {
      throw toFriendlyError(err, "Anthropic");
    }
  }

  private async *_streamOnce(
    anthropicMessages: Anthropic.MessageParam[],
    systemInstruction: string,
    anthropicTools: Anthropic.Tool[],
  ): AsyncGenerator<StreamEvent> {
    const apiStream = this.client.messages.stream({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemInstruction,
      messages: anthropicMessages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
    });

    let currentToolId = "";
    let currentToolName = "";
    let currentToolInput = "";
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of apiStream) {
      if (event.type === "message_start") {
        inputTokens = event.message.usage.input_tokens;
      } else if (event.type === "message_delta") {
        outputTokens = event.usage.output_tokens;
      } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        currentToolId = event.content_block.id;
        currentToolName = event.content_block.name;
        currentToolInput = "";
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        } else if (event.delta.type === "input_json_delta") {
          currentToolInput += event.delta.partial_json;
        }
      } else if (event.type === "content_block_stop" && currentToolName) {
        yield {
          type: "function_call",
          id: currentToolId,
          name: currentToolName,
          args: JSON.parse(currentToolInput || "{}") as Record<string, unknown>,
        };
        currentToolId = currentToolName = currentToolInput = "";
      }
    }

    if (inputTokens > 0 || outputTokens > 0) {
      yield { type: "usage", inputTokens, outputTokens };
    }
    yield { type: "done" };
  }
}

function messagesToAnthropicParams(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((msg) => {
    const role = msg.role === "model" ? "assistant" : ("user" as const);
    const content: Anthropic.ContentBlockParam[] = msg.parts.map((part) => {
      if (part.type === "text") {
        return { type: "text" as const, text: part.text };
      }
      if (part.type === "function_call") {
        return {
          type: "tool_use" as const,
          id: part.id,
          name: part.name,
          input: part.args,
        };
      }
      // function_result
      return {
        type: "tool_result" as const,
        tool_use_id: part.id,
        content: part.result,
      };
    });
    return { role, content };
  });
}

function definitionToAnthropicTool(def: ToolDefinition): Anthropic.Tool {
  return {
    name: def.name,
    description: def.description,
    input_schema: def.parameters as Anthropic.Tool["input_schema"],
  };
}
