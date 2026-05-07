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

const DEFAULT_MODEL = "gemini-3-flash-preview";

export class GeminiClient implements LLMClient {
  private client: GoogleGenAI;
  private model: string;
  private maxOutputTokens: number | undefined;

  constructor(apiKey: string, model = DEFAULT_MODEL, maxOutputTokens?: number) {
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
    this.maxOutputTokens = maxOutputTokens;
  }

  async *stream(
    messages: Message[],
    systemInstruction: string,
    tools: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    const contents = messagesToContents(messages);
    const functionDeclarations = tools.map(definitionToFunctionDeclaration);

    yield* withRetry(
      () => this._streamOnce(contents, systemInstruction, functionDeclarations),
      (err) => err instanceof ApiError && [429, 500, 502, 503].includes(err.status),
    );
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
      },
    });

    let usageInputTokens = 0;
    let usageOutputTokens = 0;

    for await (const chunk of response) {
      const candidate = chunk.candidates?.[0];
      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          if (part.text) {
            yield { type: "text", text: part.text };
          } else if (part.functionCall) {
            yield {
              type: "function_call",
              id: part.functionCall.id ?? crypto.randomUUID(),
              name: part.functionCall.name ?? "",
              args: (part.functionCall.args ?? {}) as Record<string, unknown>,
              thoughtSignature: (part as unknown as { thoughtSignature?: string }).thoughtSignature,
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
}

function messagesToContents(messages: Message[]): Content[] {
  return messages.map((msg) => ({
    role: msg.role,
    parts: msg.parts.map((part) => {
      if (part.type === "text") {
        return { text: part.text };
      }
      if (part.type === "function_call") {
        return {
          functionCall: { id: part.id, name: part.name, args: part.args },
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        };
      }
      // function_result — echo thoughtSignature back as required by Gemini thinking models
      return {
        functionResponse: {
          id: part.id,
          name: part.name,
          response: { output: part.result },
        },
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      };
    }),
  }));
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
