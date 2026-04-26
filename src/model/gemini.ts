import { GoogleGenAI, type Content, type FunctionDeclaration, type Schema } from "@google/genai";
import type { LLMClient } from "./client.js";
import type { Message, StreamEvent, ToolDefinition } from "./types.js";

const DEFAULT_MODEL = "gemini-3-flash-preview";
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

export class GeminiClient implements LLMClient {
  private client: GoogleGenAI;
  private model: string;

  constructor(apiKey: string, model = DEFAULT_MODEL) {
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async *stream(
    messages: Message[],
    systemInstruction: string,
    tools: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    const contents = messagesToContents(messages);
    const functionDeclarations = tools.map(definitionToFunctionDeclaration);

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.models.generateContentStream({
          model: this.model,
          contents,
          config: {
            systemInstruction,
            tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
          },
        });

        for await (const chunk of response) {
          const candidate = chunk.candidates?.[0];
          if (!candidate?.content?.parts) continue;

          for (const part of candidate.content.parts) {
            if (part.text) {
              yield { type: "text", text: part.text };
            } else if (part.functionCall) {
              yield {
                type: "function_call",
                id: part.functionCall.id ?? crypto.randomUUID(),
                name: part.functionCall.name ?? "",
                args: (part.functionCall.args ?? {}) as Record<string, unknown>,
                thoughtSignature: (part as unknown as { thoughtSignature?: string })
                  .thoughtSignature,
              };
            }
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
          msg.includes("RESOURCE_EXHAUSTED");

        if (!isRetryable || attempt === MAX_RETRIES - 1) throw lastError;

        const delay = RETRY_BASE_MS * 2 ** attempt;
        await sleep(delay);
      }
    }

    throw lastError;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
