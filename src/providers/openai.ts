import OpenAI from "openai";
import type { LLMClient } from "./client.js";
import type { Message, StreamEvent, ToolDefinition } from "./types.js";
import { withRetry } from "./retry.js";
import { toFriendlyError } from "./errors.js";
import { salvageToolCalls, contentIsOnlyToolCalls } from "./salvage.js";

const DEFAULT_MAX_TOKENS = 8096;

// o1/o3/o4 reasoning models use "developer" role instead of "system"
function isReasoningModel(model: string): boolean {
  return /^o[134](-|$)/.test(model);
}

/**
 * Whether the text so far could still turn out to be a tool call emitted as raw text.
 *
 * Returns false only once the content has *proved* it is ordinary prose, so that partial
 * openers ("`", "``", "<tool_ca") keep buffering until there is enough to judge. Models
 * commonly fence these payloads (```json { ... } ```), so a fence alone is not yet a
 * decision — we wait for the first character inside it.
 *
 * See `_streamOnce` and docs/design/b6-oss-models.md §4.
 */
function couldBeToolCall(text: string): boolean {
  const t = text.trimStart();
  if (t.length === 0) return true; // nothing to judge yet

  if (t.startsWith("{") || t.startsWith("[")) return true;
  if (t.startsWith("<tool_call>")) return true;
  // Partial openers — keep waiting rather than committing.
  if ("<tool_call>".startsWith(t)) return true;
  if ("```".startsWith(t)) return true;

  if (t.startsWith("```")) {
    const fence = /^```[a-zA-Z]*\r?\n?/.exec(t);
    if (!fence) return true; // still consuming the language tag
    const body = t.slice(fence[0].length).trimStart();
    if (body.length === 0) return true; // fence opened, no content yet
    return body.startsWith("{") || body.startsWith("[");
  }

  return false;
}

export class OpenAIClient implements LLMClient {
  private client: OpenAI;
  private model: string;
  private includeUsage: boolean;
  private maxTokens: number;
  private temperature: number | undefined;
  private salvage: boolean;

  constructor(
    apiKey: string,
    model: string,
    options?: {
      includeUsage?: boolean;
      maxTokens?: number;
      baseUrl?: string;
      temperature?: number;
      /** Recover tool calls emitted as plain text. Enabled for OSS/local presets. */
      salvage?: boolean;
    },
  ) {
    this.client = new OpenAI({ apiKey, ...(options?.baseUrl ? { baseURL: options.baseUrl } : {}) });
    this.model = model;
    this.includeUsage = options?.includeUsage ?? false;
    this.maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.temperature = options?.temperature;
    this.salvage = options?.salvage ?? false;
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
        () =>
          this._streamOnce(
            openaiMessages,
            openaiTools,
            tools.map((t) => t.name),
          ),
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
    toolNames: string[],
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
    let emittedCalls = 0;

    // Salvage needs the full text before it can tell a tool call from prose, but
    // buffering every response would kill streaming. Compromise: hold output back only
    // while it could still be a raw tool call, and release it the moment the content
    // proves to be ordinary prose — from then on the turn streams normally.
    let buffered = "";
    let buffering = this.salvage;

    for await (const chunk of apiStream) {
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
      }

      const choice = chunk.choices[0];
      if (!choice) continue;

      const { delta, finish_reason } = choice;

      if (delta.content) {
        if (buffering) {
          buffered += delta.content;
          if (!couldBeToolCall(buffered)) {
            // Proved to be prose — release what we held and stream the rest live.
            buffering = false;
            yield { type: "text", text: buffered };
            buffered = "";
          }
        } else {
          yield { type: "text", text: delta.content };
        }
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
        for (const call of drainCalls(pendingCalls)) {
          emittedCalls++;
          yield call;
        }
      }
    }

    // Many OpenAI-compatible servers report finish_reason "stop" even when tool calls are
    // present, which would strand them in pendingCalls. Flush anything left over.
    for (const call of drainCalls(pendingCalls)) {
      emittedCalls++;
      yield call;
    }

    if (buffered.length > 0) {
      // Only salvage when the model produced no structured calls at all — a model that
      // called tools properly and also wrote JSON prose should not have it reinterpreted.
      const salvaged = emittedCalls === 0 ? salvageToolCalls(buffered, toolNames) : [];

      for (const [i, call] of salvaged.entries()) {
        emittedCalls++;
        yield {
          type: "function_call",
          id: `salvaged_${Date.now()}_${i}`,
          name: call.name,
          args: call.args,
        };
      }

      // Suppress the raw payload only when it was entirely the tool call; if the model
      // mixed prose with JSON, the prose is still worth showing.
      if (salvaged.length === 0 || !contentIsOnlyToolCalls(buffered)) {
        yield { type: "text", text: buffered };
      }
    }

    if (inputTokens > 0 || outputTokens > 0) {
      yield { type: "usage", inputTokens, outputTokens };
    }
    yield { type: "done" };
  }
}

/** Drains accumulated streaming tool calls in index order, emptying the map. */
function* drainCalls(
  pending: Map<number, { id: string; name: string; args: string }>,
): Generator<StreamEvent> {
  const entries = [...pending.entries()].sort(([a], [b]) => a - b);
  pending.clear();

  for (const [index, tc] of entries) {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.args || "{}") as Record<string, unknown>;
    } catch {
      // A truncated or malformed argument blob would otherwise throw and abort the whole
      // stream, losing any well-formed calls alongside it. Surface it as an empty call so
      // the agent loop can report a tool error instead of crashing.
      args = {};
    }
    yield {
      type: "function_call",
      id: tc.id || `call_${index}`,
      name: tc.name,
      args,
    };
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
