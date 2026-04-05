import { GoogleGenAI, type Content, type FunctionDeclaration } from "@google/genai";
import type { Message, StreamEvent } from "./types.js";

const DEFAULT_MODEL = "gemini-3-flash-preview";
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

export class GeminiClient {
  private client: GoogleGenAI;
  private model: string;

  constructor(apiKey: string, model = DEFAULT_MODEL) {
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async *stream(
    messages: Message[],
    systemInstruction: string,
    tools: FunctionDeclaration[],
  ): AsyncGenerator<StreamEvent> {
    const contents = messagesToContents(messages);

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.models.generateContentStream({
          model: this.model,
          contents,
          config: {
            systemInstruction,
            tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
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
        lastError = err as Error;
        const isRetryable =
          lastError.message.includes("429") ||
          lastError.message.includes("503") ||
          lastError.message.includes("RESOURCE_EXHAUSTED");

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
