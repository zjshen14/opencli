import {
  GoogleGenAI,
  ApiError,
  type Content,
  type FunctionDeclaration,
  type Schema,
} from "@google/genai";
import type { LLMClient } from "./client.js";
import type { Message, StreamEvent, ToolDefinition } from "./types.js";
import { withRetry } from "./retry.js";
import { toFriendlyError } from "./errors.js";

const DEFAULT_MODEL = "gemini-3-flash-preview";

// Gemini thinking models occasionally emit these control tokens as plain text
// when function calling falls back to text-mode output. Strip them defensively
// so they never appear in user-visible streamed text.
// <end_of_turn> is a standalone tag; <start_of_turn> is followed by the role
// name as a separate text token (model or user), so both are stripped together.
const GEMINI_CONTROL_RE = /<end_of_turn>|<start_of_turn>(?:model|user)?/g;

export class GeminiClient implements LLMClient {
  private client: GoogleGenAI;
  private model: string;
  private maxOutputTokens: number | undefined;
  private temperature: number | undefined;
  // Stores thoughtSignature keyed by function call ID; populated when a thinking-model
  // functionCall is received, echoed back in the corresponding functionResponse.
  private thoughtSignatures = new Map<string, string>();

  constructor(
    apiKey: string,
    model = DEFAULT_MODEL,
    maxOutputTokens?: number,
    baseUrl?: string,
    temperature?: number,
  ) {
    this.client = new GoogleGenAI({ apiKey, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) });
    this.model = model;
    this.maxOutputTokens = maxOutputTokens;
    this.temperature = temperature;
  }

  async *stream(
    messages: Message[],
    systemInstruction: string,
    tools: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    const contents = this.messagesToContents(messages);
    const functionDeclarations = tools.map(definitionToFunctionDeclaration);

    try {
      yield* withRetry(
        () => this._streamOnce(contents, systemInstruction, functionDeclarations),
        (err) => err instanceof ApiError && [429, 500, 502, 503].includes(err.status),
      );
    } catch (err) {
      throw toFriendlyError(err, "Gemini");
    }
  }

  private async *_streamOnce(
    contents: Content[],
    systemInstruction: string,
    functionDeclarations: FunctionDeclaration[],
  ): AsyncGenerator<StreamEvent> {
    const response = await this.client.models.generateContentStream({
      model: this.model,
      contents,
      config: {
        systemInstruction,
        tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
        maxOutputTokens: this.maxOutputTokens,
        temperature: this.temperature,
      },
    });

    let usageInputTokens = 0;
    let usageOutputTokens = 0;

    for await (const chunk of response) {
      const candidate = chunk.candidates?.[0];
      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          if (part.text) {
            const filtered = part.text.replace(GEMINI_CONTROL_RE, "");
            if (filtered) yield { type: "text", text: filtered };
          } else if (part.functionCall) {
            const id = part.functionCall.id ?? crypto.randomUUID();
            const sig = (part as unknown as { thoughtSignature?: string }).thoughtSignature;
            if (sig) this.thoughtSignatures.set(id, sig);
            yield {
              type: "function_call",
              id,
              name: part.functionCall.name ?? "",
              args: (part.functionCall.args ?? {}) as Record<string, unknown>,
              ...(sig ? { thoughtSignature: sig } : {}),
            };
          }
        }
      }
      if (chunk.usageMetadata) {
        usageInputTokens = chunk.usageMetadata.promptTokenCount ?? 0;
        usageOutputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
      }
    }

    if (usageInputTokens > 0 || usageOutputTokens > 0) {
      yield { type: "usage", inputTokens: usageInputTokens, outputTokens: usageOutputTokens };
    }
    yield { type: "done" };
  }
  private messagesToContents(messages: Message[]): Content[] {
    const requiresSignature = isThinkingModel(this.model);
    return messages.map((msg) => ({
      role: msg.role,
      parts: msg.parts.map((part) => {
        if (part.type === "text") {
          return { text: part.text };
        }
        if (part.type === "function_call") {
          // Prefer the signature carried on the part itself — populated either
          // from this stream's emit or restored from the session JSONL. Fall
          // back to the in-memory map for backward compatibility with parts
          // built before signatures were threaded through.
          const sig = part.thoughtSignature ?? this.thoughtSignatures.get(part.id);
          if (!sig && requiresSignature) {
            // No signature available (old JSONL recorded before sig persistence
            // landed). Thinking models reject unsignatured functionCall — fall
            // back to a text representation so the conversation still streams.
            return { text: `[Tool call: ${part.name}(${JSON.stringify(part.args)})]` };
          }
          return {
            functionCall: { id: part.id, name: part.name, args: part.args },
            ...(sig ? { thoughtSignature: sig } : {}),
          };
        }
        // function_result — must echo its function_call's thoughtSignature.
        const sig = part.thoughtSignature ?? this.thoughtSignatures.get(part.id);
        if (!sig && requiresSignature) {
          return { text: `[Tool result: ${part.name} → ${part.result}]` };
        }
        return {
          functionResponse: {
            id: part.id,
            name: part.name,
            response: { output: part.result },
          },
          ...(sig ? { thoughtSignature: sig } : {}),
        };
      }),
    }));
  }
}

// Models that always emit (and require echoing) thoughtSignature on functionCall/Response.
// On resume the signature is lost — the JSONL doesn't carry it — so calls to these models
// would 400 unless we flatten unsignatured tool parts to text.
function isThinkingModel(model: string): boolean {
  return model.startsWith("gemini-3") || model.includes("thinking");
}

function definitionToFunctionDeclaration(def: ToolDefinition): FunctionDeclaration {
  return {
    name: def.name,
    description: def.description,
    parameters: convertSchema(def.parameters),
  };
}

function convertSchema(schema: Record<string, unknown>): Schema {
  const result: Schema = {
    type: (schema.type as string).toUpperCase() as Schema["type"],
  };

  if (schema.description) result.description = schema.description as string;
  if (schema.enum) result.enum = schema.enum as string[];

  if (schema.properties) {
    result.properties = {};
    for (const [key, val] of Object.entries(schema.properties as Record<string, unknown>)) {
      result.properties[key] = convertSchema(val as Record<string, unknown>);
    }
  }

  if (schema.items) {
    result.items = convertSchema(schema.items as Record<string, unknown>);
  }

  if (schema.required) result.required = schema.required as string[];

  return result;
}
