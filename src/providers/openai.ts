import OpenAI from "openai";
import type { LLMClient } from "./client.js";
import type { Message, StreamEvent, ToolDefinition } from "./types.js";

const DEFAULT_MAX_TOKENS = 8096;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

// o1/o3/o4 reasoning models use "developer" role instead of "system"
function isReasoningModel(model: string): boolean {
  return /^o[134](-|$)/.test(model);
}

export class OpenAIClient implements LLMClient {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async *stream(
    messages: Message[],
    systemInstruction: string,
    tools: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    const reasoning = isReasoningModel(this.model);
    const openaiMessages = messagesToOpenAIParams(messages, systemInstruction, reasoning);
    const openaiTools: OpenAI.ChatCompletionFunctionTool[] = tools.map(definitionToOpenAITool);

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const apiStream = await this.client.chat.completions.create({
          model: this.model,
          max_tokens: DEFAULT_MAX_TOKENS,
          messages: openaiMessages,
          tools: openaiTools.length > 0 ? openaiTools : undefined,
          stream: true,
        });

        const pendingCalls = new Map<number, { id: string; name: string; args: string }>();

        for await (const chunk of apiStream) {
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

        yield { type: "done" };
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const msg = lastError.message;
        const isRetryable =
          msg.includes("429") ||
          msg.includes("500") ||
          msg.includes("502") ||
          msg.includes("503") ||
          msg.includes("rate_limit");

        if (!isRetryable || attempt === MAX_RETRIES - 1) throw lastError;

        const delay = RETRY_BASE_MS * 2 ** attempt;
        await sleep(delay);
      }
    }

    throw lastError;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
