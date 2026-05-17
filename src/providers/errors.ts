export type ProviderName = "Gemini" | "Anthropic" | "OpenAI";

function extractStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status?: unknown }).status;
    return typeof s === "number" ? s : undefined;
  }
  return undefined;
}

// Gemini SDK error messages are double-nested JSON:
// outer: {"error":{"message":"<inner_json_string>","code":N}}
// inner: {"error":{"code":N,"message":"<human message>","status":"..."}}
// Unwrap both layers to surface the actionable message.
function extractGeminiMessage(raw: string): string {
  try {
    const outer = JSON.parse(raw) as { error?: { message?: string } };
    const inner = JSON.parse(outer?.error?.message ?? "{}") as { error?: { message?: string } };
    return inner?.error?.message ?? outer?.error?.message ?? raw;
  } catch {
    return raw;
  }
}

export function toFriendlyError(err: unknown, provider: ProviderName): Error {
  const status = extractStatus(err);
  const original = err instanceof Error ? err : new Error(String(err));

  let message: string;
  const innerMsg =
    provider === "Gemini" ? extractGeminiMessage(original.message) : original.message;
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
    message = `${provider} request failed: ${original.message}`;
  }

  const friendly = new Error(message);
  friendly.cause = original;
  return friendly;
}
