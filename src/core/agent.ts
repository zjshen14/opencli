import type { LLMClient } from "../providers/client.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import { toolToDefinition, activateSkillDefinition } from "../providers/schema.js";
import { ContextManager } from "./context.js";
import { executeCalls } from "./executor.js";
import type { ConfirmFn } from "./executor.js";
import { buildReminder, buildPlanSuffix } from "./prompt.js";
import type { FunctionCallPart, Message } from "../providers/types.js";
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

    const allToolDefs = [...this.tools.all().map(toolToDefinition), activateSkillDefinition];

    let toolDefinitions = allToolDefs;
    let systemInstruction: string;

    if (mode === "plan") {
      const readonlyTools = this.tools.all().filter((t) => t.readonly);
      toolDefinitions = [...readonlyTools.map(toolToDefinition), activateSkillDefinition];
      const planSuffix = buildPlanSuffix(new Set(readonlyTools.map((t) => t.name)));
      systemInstruction = this.context.getSystemInstruction(toolDefinitions) + planSuffix;
    } else {
      systemInstruction = this.context.getSystemInstruction(allToolDefs);
    }

    // A5b auto-compact: fires only at this turn-boundary position — before any
    // LLM call or tool execution this turn. Any LLM/network errors inside
    // maybeAutoCompact are caught by it; the turn always proceeds.
    for (const notice of await this.maybeAutoCompact(systemInstruction)) {
      yield notice;
    }

    let turns = 0;
    let lastCallSig = "";
    let stuckCount = 0;
    let envErrorPattern = "";
    let envErrorCount = 0;
    let emptyRetried = false;
    const firedReminders = new Set<string>();

    while (true) {
      const pendingCalls: FunctionCallPart[] = [];
      let responseText = "";

      const messages = this.context.getMessages();
      const estimatedTokens = Math.round(
        (JSON.stringify(messages).length + systemInstruction.length) / 4,
      );
      this.obs?.({ type: "context_snapshot", messageCount: messages.length, estimatedTokens });
      this.obs?.({ type: "llm_call_start", model: this.model, inputMessages: messages.length });
      const callStart = Date.now();
      let usageInputTokens = 0;
      let usageOutputTokens = 0;

      for await (const event of this.client.stream(messages, systemInstruction, toolDefinitions)) {
        if (event.type === "text") {
          responseText += event.text;
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

      const assistantParts: Message["parts"] = [];
      if (responseText) assistantParts.push({ type: "text", text: responseText });
      assistantParts.push(...pendingCalls);
      if (assistantParts.length > 0) {
        this.context.addMessage({ role: "model", parts: assistantParts });
      }

      if (pendingCalls.length === 0) {
        if (responseText.trim() === "" && !emptyRetried) {
          // Empty stream (no text, no tool calls) is likely a transient provider issue
          // (safety filter, output truncation, parse failure). Retry once before
          // treating as intentional done — nothing was added to context, so the
          // retry sees the same conversation state.
          emptyRetried = true;
          this.obs?.({ type: "empty_response_retry" });
          continue;
        }
        yield { type: "done" };
        return;
      }
      emptyRetried = false;

      // Max turns guard
      turns++;
      if (turns > this.maxTurns) {
        this.obs?.({
          type: "guard_triggered",
          guard: "max_turns",
          reason: `Reached ${this.maxTurns} turns`,
        });
        yield {
          type: "error",
          message: `Reached maximum iterations (${this.maxTurns}). Try breaking the task into smaller steps.`,
        };
        return;
      }

      // Stuck-loop detection: same tool(s) + same args N times in a row
      const sig = JSON.stringify(pendingCalls.map((c) => ({ name: c.name, args: c.args })));
      if (sig === lastCallSig) {
        stuckCount++;
        if (stuckCount >= STUCK_THRESHOLD) {
          this.obs?.({
            type: "guard_triggered",
            guard: "stuck_loop",
            reason: `${STUCK_THRESHOLD} identical consecutive call signatures`,
          });
          yield {
            type: "error",
            message: `Detected ${STUCK_THRESHOLD} identical tool calls in a row — stopping to avoid a loop.`,
          };
          return;
        }
      } else {
        lastCallSig = sig;
        stuckCount = 1;
      }

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

      // Surface any snapshot warning produced this turn as an error event.
      // drainWarning() clears it so it is only emitted once per failure.
      const snapshotWarning = this.snapshotManager?.drainWarning();
      if (snapshotWarning) {
        yield { type: "error", message: `[snapshot] ${snapshotWarning}` };
      }

      // Environmental error guard: OS-level errors (EPERM, EACCES, etc.) cannot
      // be fixed by editing code. If the same pattern recurs across consecutive
      // turns, stop and surface a diagnosis instead of burning more turns.
      const combinedResults = results.map((r) => r.result).join("\n");
      const matchedPattern = ENV_ERROR_PATTERNS.find((p) =>
        combinedResults.toLowerCase().includes(p.toLowerCase()),
      );
      if (matchedPattern) {
        if (matchedPattern === envErrorPattern) {
          envErrorCount++;
        } else {
          envErrorPattern = matchedPattern;
          envErrorCount = 1;
        }
        if (envErrorCount >= ENV_ERROR_THRESHOLD) {
          this.obs?.({
            type: "guard_triggered",
            guard: "env_error_loop",
            reason: `"${matchedPattern}" in ${ENV_ERROR_THRESHOLD} consecutive turns`,
          });
          yield {
            type: "error",
            message: `Detected "${matchedPattern}" in ${ENV_ERROR_THRESHOLD} consecutive turns. This looks like an OS or environment restriction that code changes cannot fix — check permissions, network settings, or sandbox configuration.`,
          };
          return;
        }
      } else {
        envErrorPattern = "";
        envErrorCount = 0;
      }

      // Append an event-driven reminder to the last tool result based on what
      // tools just ran — fires only when relevant (e.g. edit → "run tests").
      const reminder = buildReminder(
        pendingCalls.map((c) => ({ name: c.name, args: c.args })),
        firedReminders,
      );
      if (reminder && results.length > 0) {
        results[results.length - 1] = {
          ...results[results.length - 1],
          result: results[results.length - 1].result + reminder,
        };
      }

      const skillCalls = pendingCalls.filter((c) => c.name === "activate_skill");
      for (const call of skillCalls) {
        yield { type: "skill_activated", name: call.args.name as string };
      }

      for (const result of results) {
        yield { type: "tool_result", name: result.name, result: result.result };
      }

      if (results.length > 0) {
        this.context.addMessage({
          role: "user",
          parts: results,
        });
      }
    }
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
      return [
        {
          type: "notice",
          message: `context at ${Math.round(ratio * 100)}% — auto-compact will trigger at 75%`,
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
