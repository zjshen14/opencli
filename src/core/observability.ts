export type ObservabilityEvent =
  /** Emitted before each LLM streaming call. */
  | { type: "llm_call_start"; model: string; inputMessages: number }
  /** Emitted after the LLM stream completes. inputTokens/outputTokens are 0 if the
   *  provider did not return usage data for this call. */
  | {
      type: "llm_call_end";
      model: string;
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
    }
  /** Rough token estimate before each LLM call (chars / 4 — for pressure monitoring). */
  | { type: "context_snapshot"; messageCount: number; estimatedTokens: number }
  /** Emitted before a tool's execute() is called. */
  | { type: "tool_exec_start"; name: string; args: Record<string, unknown> }
  /** Emitted after a tool's execute() returns. */
  | {
      type: "tool_exec_end";
      name: string;
      latencyMs: number;
      success: boolean;
      outputBytes: number;
    }
  /** Emitted when a tool call is blocked without execution. */
  | { type: "tool_denied"; name: string; reason: "plan_mode" | "user_denied" | "non_interactive" }
  /** Emitted when a safety guard aborts the loop (max-turns, stuck-loop, env-error). */
  | {
      type: "guard_triggered";
      guard: "max_turns" | "stuck_loop" | "env_error_loop";
      reason: string;
    };

export type ObservabilityHandler = (event: ObservabilityEvent) => void;
