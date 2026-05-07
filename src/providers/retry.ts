export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RETRY_BASE_MS = 1000;

export async function* withRetry<T>(
  factory: () => AsyncGenerator<T>,
  isRetryable: (err: Error) => boolean,
  maxRetries = DEFAULT_MAX_RETRIES,
  baseMs = DEFAULT_RETRY_BASE_MS,
): AsyncGenerator<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      yield* factory();
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!isRetryable(lastError) || attempt === maxRetries - 1) throw lastError;
      await new Promise<void>((r) => setTimeout(r, baseMs * 2 ** attempt));
    }
  }
  throw lastError;
}
