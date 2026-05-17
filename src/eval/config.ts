export interface Provider {
  label: string;
  model: string;
}

export function configuredProviders(): Provider[] {
  const providers: Provider[] = [];
  if (process.env.ANTHROPIC_API_KEY)
    providers.push({
      label: "anthropic",
      model: process.env.EVAL_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
    });
  if (process.env.GEMINI_API_KEY)
    providers.push({
      label: "gemini",
      model: process.env.EVAL_GEMINI_MODEL ?? "gemini-3.1-flash-lite-preview",
    });
  if (process.env.OPENAI_API_KEY)
    providers.push({
      label: "openai",
      model: process.env.EVAL_OPENAI_MODEL ?? "gpt-4o-mini",
    });

  if (providers.length === 0) {
    throw new Error(
      "No eval providers configured — set at least one of ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY",
    );
  }
  return providers;
}
