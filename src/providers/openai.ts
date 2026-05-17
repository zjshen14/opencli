import OpenAI from "openai";
import type { LLMClient } from "./client.js";
import type { Message, StreamEvent, ToolDefinition } from "./types.js";
import { withRetry } from "./retry.js";
import { toFriendlyError } from "./errors.js";

const DEFAULT_MAX_TOKENS = 8096;

// o1/o3/o4 reasoning models use "developer" role instead of "system"
function isReasoningModel(model: string): boolean {
  return /^o[134](-|$)/.test(model);
}

export class OpenAIClient implements LLMClient {
  private client: OpenAI;
  private model: string;
  private includeUsage: boolean;
  private maxTokens: number;
  private temperature: number | undefined;

  constructor(
    apiKey: string,
    model: string,
    options?: {
      includeUsage?: boolean;
      maxTokens?: number;
      baseUrl?: string;
      temperature?: number;
    },
  ) {
    this.client = new OpenAI({ apiKey, ...(options?.baseUrl ? { baseURL: options.baseUrl } : {}) });
    this.model = model;
    this.includeUsage = options?.includeUsage ?? false;
    this.maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.temperature = options?.temperature;
  }

  async *stream(
    messages: Message[],
    systemInstruction: string,
    tools: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    const reasoning = isReasoningModel(this.model);
    const openaiMessages = messagesToOpenAIParams(messages, systemInstruction, reasoning);
    const openaiTools: OpenAI.ChatCompletionFunctionTool[] = tools.map(definitionToOpenAITool);

    try {
      yield* withRetry(
        () => this._streamOnce(openaiMessages, openaiTools),
        (err) => {
          const msg = err.message;
          return (
            msg.includes("429") ||
            msg.includes("500") ||
            msg.includes("502") ||
            msg.includes("503") ||
            msg.includes("rate_limit")
          );
        },
      );
    } catch (err) {
      throw toFriendlyError(err, "OpenAI");
    }
  }

  private async *_streamOnce(
    openaiMessages: OpenAI.ChatCompletionMessageParam[],
    openaiTools: OpenAI.ChatCompletionFunctionTool[],
  ): AsyncGenerator<StreamEvent> {
    const apiStream = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: openaiMessages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      stream: true,
      stream_options: this.includeUsage ? { include_usage: true } : undefined,
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
    });

    const pendingCalls = new Map<number, { id: string; name: string; args: string }>();
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of apiStream) {
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
      }

      const choice = chunk.choices[0];
      if (!choice) continue;

      const { delta, finish_reason } = choice;

      if (delta.content) {
        yield { type: "text", text: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const acc = pendingCalls.get(tc.index);
          if (acc) {
            acc.args += tc.function?.arguments ?? "";
          } else {
            pendingCalls.set(tc.index, {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              args: tc.function?.arguments ?? "",
            });
          }
        }
      }

      if (finish_reason === "tool_calls") {
        for (const [, tc] of [...pendingCalls.entries()].sort(([a], [b]) => a - b)) {
          yield {
            type: "function_call",
            id: tc.id,
            name: tc.name,
            args: JSON.parse(tc.args || "{}") as Record<string, unknown>,
          };
        }
        pendingCalls.clear();
      }
    }

    if (inputTokens > 0 || outputTokens > 0) {
      yield { type: "usage", inputTokens, outputTokens };
    }
    yield { type: "done" };
  }
}

function messagesToOpenAIParams(
  messages: Message[],
  systemInstruction: string,
  reasoning: boolean,
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [];

  if (reasoning) {
    result.push({ role: "developer", content: systemInstruction });
  } else {
    result.push({ role: "system", content: systemInstruction });
  }

  for (const msg of messages) {
    if (msg.role === "model") {
      const textPart = msg.parts.find((p) => p.type === "text");
      const funcCalls = msg.parts.filter((p) => p.type === "function_call");

      result.push({
        role: "assistant",
        content: textPart?.type === "text" ? textPart.text : null,
        tool_calls:
          funcCalls.length > 0
            ? funcCalls.map((p) => {
                if (p.type !== "function_call") throw new Error("unexpected part type");
                return {
                  id: p.id,
                  type: "function" as const,
                  function: { name: p.name, arguments: JSON.stringify(p.args) },
                };
              })
            : undefined,
      });
    } else {
      const funcResults = msg.parts.filter((p) => p.type === "function_result");
      const textParts = msg.parts.filter((p) => p.type === "text");

      for (const p of funcResults) {
        if (p.type !== "function_result") continue;
        result.push({ role: "tool", tool_call_id: p.id, content: p.result });
      }

      if (textParts.length > 0) {
        result.push({
          role: "user",
          content: textParts.map((p) => (p.type === "text" ? p.text : "")).join(""),
        });
      }
    }
  }

  return result;
}

function definitionToOpenAITool(def: ToolDefinition): OpenAI.ChatCompletionFunctionTool {
  return {
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters as OpenAI.FunctionParameters,
    },
  };
}
