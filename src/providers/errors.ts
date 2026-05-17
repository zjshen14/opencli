export type ProviderName = "Gemini" | "Anthropic" | "OpenAI";

function extractStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status?: unknown }).status;
    return typeof s === "number" ? s : undefined;
  }
  return undefined;
}

// SDK error messages often contain JSON with a nested human-readable description.
// This handles single-level {"error":{"message":"..."}} or {"message":"..."} payloads,
// and also Gemini's double-nested pattern where the outer message field is itself JSON.
function extractHumanMessage(raw: string): string {
  try {
    type Payload = { error?: { message?: string }; message?: string };
    const outer = JSON.parse(raw) as Payload;
    const candidate = outer?.error?.message ?? outer?.message;
    if (!candidate) return raw;
    // Gemini wraps a second JSON string inside the outer message field — unwrap it.
    try {
      const inner = JSON.parse(candidate) as Payload;
      return inner?.error?.message ?? inner?.message ?? candidate;
    } catch {
      return candidate;
    }
  } catch {
    return raw;
  }
}

export function toFriendlyError(err: unknown, provider: ProviderName): Error {
  const status = extractStatus(err);
  const original = err instanceof Error ? err : new Error(String(err));

  let message: string;
  const innerMsg = extractHumanMessage(original.message);
  if (status === 400) {
    // 400 covers many distinct Gemini cases (expired key, billing not enabled,
    // invalid schema, context too long, etc.) — surface the inner message directly.
    message = `${provider}: bad request (400). ${innerMsg}`;
  } else if (status === 404) {
    message = `${provider}: model not found (404). ${innerMsg} Try a different model with --model.`;
  } else if (status === 401) {
    const flag =
      provider === "Gemini"
        ? "--gemini-api-key"
        : provider === "Anthropic"
          ? "--anthropic-api-key"
          : "--openai-api-key";
    message = `Invalid ${provider} API key. Run: opencli config ${flag} <key>`;
  } else if (status === 403) {
    message = `${provider} access denied (403). Check your API key permissions.`;
  } else if (status === 429) {
    message = `${provider} rate limit hit. Wait and retry, or switch to a different model with --model.`;
  } else if (status !== undefined && status >= 500) {
    message = `${provider} server error (${status}). Try again in a moment.`;
  } else {
    message = `${provider} request failed: ${innerMsg}`;
  }

  const friendly = new Error(message);
  friendly.cause = original;
  return friendly;
}
