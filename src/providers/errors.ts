export type ProviderName = "Gemini" | "Anthropic" | "OpenAI";

function extractStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status?: unknown }).status;
    return typeof s === "number" ? s : undefined;
  }
  return undefined;
}

export function toFriendlyError(err: unknown, provider: ProviderName): Error {
  const status = extractStatus(err);
  const original = err instanceof Error ? err : new Error(String(err));

  let message: string;
  if (status === 400) {
    message = `${provider}: bad request (400) — the context may be too long or contain unsupported content.`;
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
