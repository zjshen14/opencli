import type { LLMClient } from "../providers/client.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import { toolToDefinition, activateSkillDefinition } from "../providers/schema.js";
import { ContextManager } from "./context.js";
import { executeCalls } from "./executor.js";
import type { ConfirmFn } from "./executor.js";
import { buildReminder, buildPlanSuffix, buildPeriodicReminder } from "./prompt.js";
import type {
  FunctionCallPart,
  FunctionResultPart,
  Message,
  ToolDefinition,
} from "../providers/types.js";
import type { ObservabilityHandler } from "./observability.js";
import type { SnapshotManager } from "../state/snapshot.js";
import { compactHistory, contextWindowFor, COMPACTION_TARGET_TOKENS } from "./compact.js";
import type { CompactResult } from "./compact.js";

export type AgentEvent =
  | { type: "text"; text: string }
  | {
      type: "tool_call";
      name: string;
      args: Record<string, unknown>;
      thoughtSignature?: string;
    }
  | { type: "tool_result"; name: string; result: string }
  | { type: "skill_activated"; name: string }
  | { type: "error"; message: string }
  /** Non-fatal informational message (e.g. auto-compact warnings/results).
   *  Distinct from "error" so the renderer can style them differently. */
  | { type: "notice"; message: string }
  | { type: "done" };

const AUTO_COMPACT_WARN_RATIO = 0.6;
const AUTO_COMPACT_TRIGGER_RATIO = 0.75;

const DEFAULT_MAX_TURNS = 50;
const STUCK_THRESHOLD = 3;
const ENV_ERROR_THRESHOLD = 3;

// Per-turn mutable state passed through the run() pipeline. Each guard reads
// and updates the fields it owns; the loop is otherwise stateless. Kept as a
// plain interface (not a class) so guard methods can mutate counters without
// ceremony.
interface TurnState {
  turns: number;
  lastCallSig: string;
  stuckCount: number;
  envErrorPattern: string;
  envErrorCount: number;
  emptyRetried: boolean;
  firedReminders: Set<string>;
}

interface TurnSetup {
  toolDefinitions: ToolDefinition[];
  systemInstruction: string;
}

// OS-level errors that code changes cannot fix. If the same pattern appears in
// tool results across ENV_ERROR_THRESHOLD consecutive turns, the loop aborts.
const ENV_ERROR_PATTERNS = [
  "EPERM",
  "EACCES",
  "ENOSPC",
  "EMFILE",
  "ENOMEM",
  "permission denied",
  "operation not permitted",
  "access is denied",
  "no space left on device",
  "too many open files",
];

export type AgentRunMode = "react" | "plan";

export class Agent {
  private context: ContextManager;
  private confirmFn?: ConfirmFn;
  private forcesConfirmationFn?: (toolName: string, args: Record<string, unknown>) => boolean;
  private model: string;
  private obs?: ObservabilityHandler;
  private snapshotManager?: SnapshotManager;
  private compactionClient: LLMClient;
  private autoCompact: boolean;
  /** Whether the 60% notice has fired this session; resets on clearHistory()
   *  and on successful compaction. */
  private warnedAt60 = false;

  constructor(
    private client: LLMClient,
    private tools: ToolRegistry,
    private skills: SkillRegistry,
    systemInstruction?: string,
    maxHistoryMessages?: number,
    private maxTurns: number = DEFAULT_MAX_TURNS,
    options?: {
      model?: string;
      onObservability?: ObservabilityHandler;
      snapshotManager?: SnapshotManager;
      compactionClient?: LLMClient;
      /** When true (default), auto-compact at turn boundary above 75% token ratio. */
      autoCompact?: boolean;
    },
  ) {
    this.context = new ContextManager(systemInstruction, maxHistoryMessages);
    this.context.setSkillCatalog(skills.catalogSummary());
    this.model = options?.model ?? "";
    this.obs = options?.onObservability;
    this.snapshotManager = options?.snapshotManager;
    this.compactionClient = options?.compactionClient ?? client;
    this.autoCompact = options?.autoCompact !== false;
  }

  setConfirmFn(fn: ConfirmFn): void {
    this.confirmFn = fn;
  }

  setForcesConfirmationFn(fn: (toolName: string, args: Record<string, unknown>) => boolean): void {
    this.forcesConfirmationFn = fn;
  }

  setSessionTmpDir(dir: string): void {
    this.context.setSessionTmpDir(dir);
  }

  restoreMessages(messages: Message[]): void {
    this.context.restoreMessages(messages);
  }

  injectSkill(name: string, body: string): void {
    if (!this.context.hasSkill(name)) {
      this.context.addSkillContent(name, body);
    }
  }

  async *run(userInput: string, mode: AgentRunMode = "react"): AsyncGenerator<AgentEvent> {
    this.context.addMessage({
      role: "user",
      parts: [{ type: "text", text: userInput }],
    });

    const setup = this.buildTurnSetup(mode);

    // A5b auto-compact: fires only at this turn-boundary position — before any
    // LLM call or tool execution this turn. Skipped in plan mode: read-only
    // exploration shouldn't spend tokens on a compaction round-trip.
    if (mode !== "plan") {
      for (const notice of await this.maybeAutoCompact(setup.systemInstruction)) {
        yield notice;
      }
    }

    const state: TurnState = {
      turns: 0,
      lastCallSig: "",
      stuckCount: 0,
      envErrorPattern: "",
      envErrorCount: 0,
      emptyRetried: false,
      firedReminders: new Set<string>(),
    };

    while (true) {
      // 1. Stream from LLM (collect text + tool calls; observability)
      const { text, pendingCalls } = yield* this.streamLLM(setup);

      // 2. Record assistant message in context
      this.recordAssistantMessage(text, pendingCalls);

      // 3. Done / empty-retry — exits early if no tool calls
      if (pendingCalls.length === 0) {
        if (text.trim() === "" && !state.emptyRetried) {
          // Empty stream is likely a transient provider issue (safety filter,
          // output truncation, parse failure). Nothing was added to context,
          // so the retry sees the same conversation state.
          state.emptyRetried = true;
          this.obs?.({ type: "empty_response_retry" });
          continue;
        }
        yield { type: "done" };
        return;
      }
      state.emptyRetried = false;

      // 4. Loop guards (max-turns, stuck-loop) — abort with an error event if hit
      state.turns++;
      const maxTurnsAbort = this.checkMaxTurnsGuard(state);
      if (maxTurnsAbort) {
        yield maxTurnsAbort;
        return;
      }
      const stuckAbort = this.checkStuckLoopGuard(state, pendingCalls);
      if (stuckAbort) {
        yield stuckAbort;
        return;
      }

      // 5. Execute pending tool calls
      const results = await this.executeTurnTools(pendingCalls, mode);

      // 6. Drain any snapshot warning produced this turn
      yield* this.drainSnapshotWarnings();

      // 7. Environment-error guard (OS-level errors that code changes can't fix)
      const envAbort = this.checkEnvErrorGuard(state, results);
      if (envAbort) {
        yield envAbort;
        return;
      }

      // 8. Append event-driven reminder to the last tool result (e.g. edit → "run tests")
      this.applyReminderToLastResult(state, pendingCalls, results);

      // 9. Yield skill activations + tool results to the caller
      yield* this.yieldSkillActivations(pendingCalls);
      yield* this.yieldToolResults(results);

      // 10. Record results in context so the next LLM turn sees them
      this.recordToolResults(results);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Helpers below decompose the run() loop into named steps. Each owns one
  // concern, can be unit-tested in isolation, and either yields events,
  // mutates the TurnState, mutates context, or returns an abort event for
  // the caller to yield. Splitting them up keeps run() readable as a 10-step
  // pipeline rather than a 200-line generator.
  // ────────────────────────────────────────────────────────────────────────

  private buildTurnSetup(mode: AgentRunMode): TurnSetup {
    const allToolDefs = [...this.tools.all().map(toolToDefinition), activateSkillDefinition];
    if (mode === "plan") {
      const readonlyTools = this.tools.all().filter((t) => t.readonly);
      const toolDefinitions = [...readonlyTools.map(toolToDefinition), activateSkillDefinition];
      const planSuffix = buildPlanSuffix(new Set(readonlyTools.map((t) => t.name)));
      const systemInstruction = this.context.getSystemInstruction(toolDefinitions) + planSuffix;
      return { toolDefinitions, systemInstruction };
    }
    return {
      toolDefinitions: allToolDefs,
      systemInstruction: this.context.getSystemInstruction(allToolDefs),
    };
  }

  private async *streamLLM(
    setup: TurnSetup,
  ): AsyncGenerator<AgentEvent, { text: string; pendingCalls: FunctionCallPart[] }> {
    const messages = this.context.getMessages();
    const estimatedTokens = Math.round(
      (JSON.stringify(messages).length + setup.systemInstruction.length) / 4,
    );
    this.obs?.({ type: "context_snapshot", messageCount: messages.length, estimatedTokens });
    this.obs?.({ type: "llm_call_start", model: this.model, inputMessages: messages.length });

    const callStart = Date.now();
    let usageInputTokens = 0;
    let usageOutputTokens = 0;
    let text = "";
    const pendingCalls: FunctionCallPart[] = [];

    for await (const event of this.client.stream(
      messages,
      setup.systemInstruction,
      setup.toolDefinitions,
    )) {
      if (event.type === "text") {
        text += event.text;
        yield { type: "text", text: event.text };
      } else if (event.type === "function_call") {
        pendingCalls.push({
          type: "function_call",
          id: event.id,
          name: event.name,
          args: event.args,
          ...(event.thoughtSignature ? { thoughtSignature: event.thoughtSignature } : {}),
        });
        yield {
          type: "tool_call",
          name: event.name,
          args: event.args,
          ...(event.thoughtSignature ? { thoughtSignature: event.thoughtSignature } : {}),
        };
      } else if (event.type === "usage") {
        usageInputTokens = event.inputTokens;
        usageOutputTokens = event.outputTokens;
      }
    }

    this.obs?.({
      type: "llm_call_end",
      model: this.model,
      inputTokens: usageInputTokens,
      outputTokens: usageOutputTokens,
      latencyMs: Date.now() - callStart,
    });

    return { text, pendingCalls };
  }

  private recordAssistantMessage(text: string, pendingCalls: FunctionCallPart[]): void {
    const assistantParts: Message["parts"] = [];
    if (text) assistantParts.push({ type: "text", text });
    assistantParts.push(...pendingCalls);
    if (assistantParts.length > 0) {
      this.context.addMessage({ role: "model", parts: assistantParts });
    }
  }

  private checkMaxTurnsGuard(state: TurnState): AgentEvent | null {
    if (state.turns <= this.maxTurns) return null;
    this.obs?.({
      type: "guard_triggered",
      guard: "max_turns",
      reason: `Reached ${this.maxTurns} turns`,
    });
    return {
      type: "error",
      message: `Reached maximum iterations (${this.maxTurns}). Try breaking the task into smaller steps.`,
    };
  }

  private checkStuckLoopGuard(
    state: TurnState,
    pendingCalls: FunctionCallPart[],
  ): AgentEvent | null {
    const sig = JSON.stringify(pendingCalls.map((c) => ({ name: c.name, args: c.args })));
    if (sig !== state.lastCallSig) {
      state.lastCallSig = sig;
      state.stuckCount = 1;
      return null;
    }
    state.stuckCount++;
    if (state.stuckCount < STUCK_THRESHOLD) return null;
    this.obs?.({
      type: "guard_triggered",
      guard: "stuck_loop",
      reason: `${STUCK_THRESHOLD} identical consecutive call signatures`,
    });
    return {
      type: "error",
      message: `Detected ${STUCK_THRESHOLD} identical tool calls in a row — stopping to avoid a loop.`,
    };
  }

  private async executeTurnTools(
    pendingCalls: FunctionCallPart[],
    mode: AgentRunMode,
  ): Promise<FunctionResultPart[]> {
    const { results } = await executeCalls(pendingCalls, {
      tools: this.tools,
      skills: this.skills,
      context: this.context,
      tmpDir: this.context.getSessionTmpDir(),
      readOnly: mode === "plan",
      confirmFn: this.confirmFn,
      forcesConfirmation: this.forcesConfirmationFn,
      obs: this.obs,
      snapshot: this.snapshotManager,
      cwd: process.cwd(),
    });
    return results;
  }

  // drainWarning() clears the warning so it is only emitted once per failure.
  private *drainSnapshotWarnings(): Generator<AgentEvent> {
    const snapshotWarning = this.snapshotManager?.drainWarning();
    if (snapshotWarning) {
      yield { type: "error", message: `[snapshot] ${snapshotWarning}` };
    }
  }

  private checkEnvErrorGuard(state: TurnState, results: FunctionResultPart[]): AgentEvent | null {
    const combinedResults = results
      .map((r) => r.result)
      .join("\n")
      .toLowerCase();
    const matchedPattern = ENV_ERROR_PATTERNS.find((p) =>
      combinedResults.includes(p.toLowerCase()),
    );
    if (!matchedPattern) {
      state.envErrorPattern = "";
      state.envErrorCount = 0;
      return null;
    }
    if (matchedPattern === state.envErrorPattern) {
      state.envErrorCount++;
    } else {
      state.envErrorPattern = matchedPattern;
      state.envErrorCount = 1;
    }
    if (state.envErrorCount < ENV_ERROR_THRESHOLD) return null;
    this.obs?.({
      type: "guard_triggered",
      guard: "env_error_loop",
      reason: `"${matchedPattern}" in ${ENV_ERROR_THRESHOLD} consecutive turns`,
    });
    return {
      type: "error",
      message: `Detected "${matchedPattern}" in ${ENV_ERROR_THRESHOLD} consecutive turns. This looks like an OS or environment restriction that code changes cannot fix — check permissions, network settings, or sandbox configuration.`,
    };
  }

  private applyReminderToLastResult(
    state: TurnState,
    pendingCalls: FunctionCallPart[],
    results: FunctionResultPart[],
  ): void {
    const eventReminder = buildReminder(
      pendingCalls.map((c) => ({ name: c.name, args: c.args })),
      state.firedReminders,
    );
    const periodicReminder = buildPeriodicReminder(state.turns);
    const combined = eventReminder + periodicReminder;
    if (combined && results.length > 0) {
      results[results.length - 1] = {
        ...results[results.length - 1],
        result: results[results.length - 1].result + combined,
      };
    }
  }

  private *yieldSkillActivations(pendingCalls: FunctionCallPart[]): Generator<AgentEvent> {
    for (const call of pendingCalls) {
      if (call.name === "activate_skill") {
        yield { type: "skill_activated", name: call.args.name as string };
      }
    }
  }

  private *yieldToolResults(results: FunctionResultPart[]): Generator<AgentEvent> {
    for (const result of results) {
      yield { type: "tool_result", name: result.name, result: result.result };
    }
  }

  private recordToolResults(results: FunctionResultPart[]): void {
    if (results.length === 0) return;
    this.context.addMessage({ role: "user", parts: results });
  }

  async compact(): Promise<CompactResult> {
    this.obs?.({ type: "compact_started", trigger: "manual" });
    try {
      const result = await compactHistory(this.context, this.compactionClient);
      // Re-arm the 60% notice — ratio drops well below 60% after a successful
      // compaction; the next climb back toward the threshold should warn again.
      this.warnedAt60 = false;
      this.obs?.({
        type: "compact_completed",
        trigger: "manual",
        messagesRemoved: result.messagesRemoved,
        summaryLength: result.summaryLength,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.obs?.({ type: "compact_failed", trigger: "manual", error: message });
      throw err; // manual compact propagates; only auto-compact swallows errors
    }
  }

  /**
   * Auto-compact gate. Runs at the top of run() before any LLM call.
   *
   * Returns the events to yield (notice events for user-visible state). Never
   * throws — the turn must proceed even if compaction fails. The 60% notice
   * fires at most once per session (or until clearHistory / a successful
   * compaction re-arms it).
   *
   * Token estimate intentionally includes `systemInstruction` because that's
   * what the agent actually sends to client.stream() on the next iteration —
   * counting only messages would under-estimate the real payload.
   */
  private async maybeAutoCompact(systemInstruction: string): Promise<AgentEvent[]> {
    if (!this.autoCompact) return [];

    const messages = this.context.getMessages();
    const estimatedTokens = Math.round(
      (JSON.stringify(messages).length + systemInstruction.length) / 4,
    );
    const effectiveWindow = Math.min(contextWindowFor(this.model), COMPACTION_TARGET_TOKENS);
    const ratio = estimatedTokens / effectiveWindow;

    if (ratio < AUTO_COMPACT_WARN_RATIO) return [];

    if (ratio < AUTO_COMPACT_TRIGGER_RATIO) {
      if (this.warnedAt60) return [];
      this.warnedAt60 = true;
      this.obs?.({ type: "compact_threshold_warned", ratio });
      // Phrase the notice against the *compaction budget*, not the raw model
      // window — otherwise a Gemini (1M window) user at 154k/256k effective
      // would see "context at 60%" while actually using ~15% of their model's
      // real context, which reads as a hard hit on the LLM's capacity.
      const budgetKb = Math.round(effectiveWindow / 1000);
      const usedKb = Math.round(estimatedTokens / 1000);
      return [
        {
          type: "notice",
          message: `approaching auto-compact threshold — ${usedKb}k / ${budgetKb}k tokens used (compacts at 75% of budget)`,
        },
      ];
    }

    // ratio ≥ 0.75 — auto-compact this turn
    this.obs?.({ type: "compact_started", trigger: "auto", ratio });
    try {
      const result = await compactHistory(this.context, this.compactionClient);
      this.warnedAt60 = false; // re-arm — ratio drops well below 60% after compaction
      this.obs?.({
        type: "compact_completed",
        trigger: "auto",
        messagesRemoved: result.messagesRemoved,
        summaryLength: result.summaryLength,
      });
      return [
        {
          type: "notice",
          message: `auto-compacted ${result.messagesRemoved} older messages into a ${result.summaryLength}-char summary`,
        },
      ];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.obs?.({ type: "compact_failed", trigger: "auto", error: message });
      return [
        {
          type: "notice",
          message: `auto-compact failed: ${message} — continuing with full history`,
        },
      ];
    }
  }

  getContextStats(): {
    messageCount: number;
    estimatedTokens: number;
    contextWindow: number;
    maxHistoryMessages: number;
  } {
    const messages = this.context.getMessages();
    return {
      messageCount: this.context.messageCount,
      estimatedTokens: Math.round(JSON.stringify(messages).length / 4),
      contextWindow: contextWindowFor(this.model),
      maxHistoryMessages: this.context.maxMessages,
    };
  }

  undoLastTurn(): number {
    return this.context.popTurn();
  }

  clearHistory(): void {
    this.context.clear();
    this.warnedAt60 = false;
  }
}
