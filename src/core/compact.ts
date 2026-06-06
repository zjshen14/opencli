import type { LLMClient } from "../providers/client.js";
import type { Message } from "../providers/types.js";
import type { ContextManager } from "./context.js";

export interface CompactResult {
  messagesRemoved: number;
  summaryLength: number;
}

const KEEP_RECENT = 10;
const COMPACT_MIN_MESSAGES = 4;

// Longest-prefix-first; order matters — more specific prefixes must come before shorter ones.
const MODEL_CONTEXT_WINDOWS: [prefix: string, tokens: number][] = [
  ["gemini-2.5", 1_048_576],
  ["gemini-2.0", 1_048_576],
  ["gemini-1.5", 1_048_576],
  ["gemini-3", 1_048_576],
  ["claude-", 200_000],
  ["gpt-4.1", 128_000],
  ["gpt-4o", 128_000],
  // Mini/preview reasoning models have 128k context; must come before the base o1/o3/o4 entries.
  ["o1-mini", 128_000],
  ["o1-preview", 128_000],
  ["o3-mini", 128_000],
  ["o4-mini", 128_000],
  ["o1", 200_000],
  ["o3", 200_000],
  ["o4", 200_000],
];

const DEFAULT_CONTEXT_WINDOW = 100_000;

/**
 * Cap on the effective compaction window. Auto-compact's trigger uses
 * `min(contextWindowFor(model), COMPACTION_TARGET_TOKENS)` so that very
 * large model windows (e.g. Gemini 1M) don't push the trigger so high it
 * never fires in practice. See docs/design/a5-compact-context.md §2.
 */
export const COMPACTION_TARGET_TOKENS = 256_000;

const SUMMARIZATION_PROMPT = `Summarize this coding session for context compaction.
Respond with exactly these five sections using these headers — do not add or rename sections:

## Task
The original user request and overall goal. One or two sentences.

## Progress
What has been completed. List every file created or modified with its exact path.

## Decisions
Key technical choices made during the session and the reason for each.

## Errors
Any error messages or test failures encountered. Quote them exactly — do not paraphrase.
If resolved, state the resolution. If unresolved, say so.

## State
Current state of work and the immediate next steps remaining.

Rules:
- Under 400 words total.
- Copy file paths, error messages, function names, and version numbers exactly.
- Do not narrate tool calls. Focus on outcomes and current state.
- If the input contains a block labeled "**Original task** (verbatim):" followed by quoted ("> ...") lines, OMIT that block entirely from your response. The calling code preserves the original task separately and prepends it; including it here would duplicate it on every nested compaction.`;

/**
 * Pull the original user task — the first user-role text message — out of the
 * head at compaction time. Returns "" if there is no such message.
 *
 * Three shapes this function recognises:
 *  1. A plain user-text message — that text IS the original task.
 *  2. A user-text message that PR #154's prune anchor has merged with the next
 *     turn via "\n\n[earlier conversation pruned]\n\n…". Keep only the prefix
 *     before that separator — otherwise the next user turn leaks into the
 *     quote on long sessions where prune fires before compaction does.
 *  3. A summary message from a prior compaction containing a "**Original
 *     task** (verbatim):" block. Lift the inner quoted lines directly so the
 *     text is reconstructed by string equality, not paraphrase.
 *
 * The calling code prepends the result as a quotation block in the summary
 * body. SUMMARIZATION_PROMPT instructs the model to OMIT any existing block
 * so the result isn't duplicated on nested compactions.
 */
function extractOriginalTask(messages: Message[]): string {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const text = msg.parts.find((p) => p.type === "text");
    if (text && text.type === "text" && text.text.trim()) {
      // Shape 3 (nested compaction): an existing quotation block — lift its
      // contents directly, ignoring any surrounding text.
      const nested = text.text.match(/\*\*Original task\*\* \(verbatim\):\n((?:> .*\n?)+)/);
      if (nested) {
        return nested[1].replace(/^> /gm, "").trimEnd();
      }
      // Shape 2 (prune-merged): PR #154 anchor merged the original task with
      // the next user-text turn via "[earlier conversation pruned]". Only the
      // prefix before that marker is the original task; the suffix is later
      // content that the summary itself will cover.
      const elisionIdx = text.text.indexOf("\n\n[earlier conversation pruned]");
      if (elisionIdx >= 0) {
        return text.text.slice(0, elisionIdx);
      }
      // Shape 1 (plain): use as-is.
      return text.text;
    }
  }
  return "";
}

export function contextWindowFor(model: string): number {
  for (const [prefix, size] of MODEL_CONTEXT_WINDOWS) {
    if (model.startsWith(prefix)) return size;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

function extractErrorResults(messages: Message[]): string[] {
  const errors: string[] = [];
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "function_result" && part.result.includes("Error:")) {
        errors.push(`[${part.name}] ${part.result}`);
      }
    }
  }
  return errors;
}

// Cap per-part text length in the flattened head sent to the compaction model.
// Bounds the request size against pathological cases (huge write payloads,
// 10MB grep dumps) while leaving enough room for full error output / stack
// traces. The verbatim-error block in compactHistory preserves the original
// text for results containing "Error:", so this cap is the floor, not the
// only signal the summarizer gets for failures.
const PART_FLATTEN_CAP = 2_000;

function truncate(s: string, cap = PART_FLATTEN_CAP): string {
  return s.length > cap ? s.slice(0, cap) + "…" : s;
}

// Convert function_call and function_result parts to plain text so the
// compaction model can process history without requiring tool declarations.
// Empty messages get a placeholder rather than being filtered, so role
// alternation (required by some providers) is preserved.
function flattenMessages(messages: Message[]): Message[] {
  return messages.map((msg) => {
    const lines: string[] = [];
    for (const part of msg.parts) {
      if (part.type === "text") {
        lines.push(part.text);
      } else if (part.type === "function_call") {
        lines.push(`[Tool call: ${part.name}(${truncate(JSON.stringify(part.args))})]`);
      } else if (part.type === "function_result") {
        lines.push(`[Tool result: ${part.name} → ${truncate(part.result)}]`);
      }
    }
    const text = lines.join("\n").trim();
    return {
      role: msg.role,
      parts: [{ type: "text" as const, text: text || "[empty turn]" }],
    };
  });
}

async function streamToText(
  client: LLMClient,
  messages: Message[],
  prompt: string,
): Promise<string> {
  const chunks: string[] = [];
  for await (const event of client.stream(flattenMessages(messages), prompt, [])) {
    if (event.type === "text") chunks.push(event.text);
  }
  return chunks.join("");
}

/**
 * Replace old messages in `context` with a structured LLM-generated summary.
 * Keeps the most recent KEEP_RECENT messages verbatim.
 * Error signals from tool results are quoted verbatim in the summary.
 * Returns { messagesRemoved: 0 } if history is too short to compact.
 * Never throws — propagates LLM errors to the caller.
 */
export async function compactHistory(
  context: ContextManager,
  compactionClient: LLMClient,
): Promise<CompactResult> {
  if (context.messageCount < COMPACT_MIN_MESSAGES) {
    return { messagesRemoved: 0, summaryLength: 0 };
  }

  const messages = context.getMessages();
  const tail = messages.slice(-KEEP_RECENT);
  const head = messages.slice(0, -KEEP_RECENT);

  if (head.length === 0) {
    return { messagesRemoved: 0, summaryLength: 0 };
  }

  // Order matters: extractErrorResults and extractOriginalTask must run on
  // the original messages, before streamToText flattens them. Flattening
  // collapses function_result parts into bounded-length text, which would
  // defeat verbatim error preservation for any error longer than
  // PART_FLATTEN_CAP. The original-task extraction runs on the head so it
  // also picks up the verbatim quotation from a prior summary (nested
  // compaction case).
  const errors = extractErrorResults(head);
  const originalTask = extractOriginalTask(head);
  const summary = await streamToText(compactionClient, head, SUMMARIZATION_PROMPT);

  const errorBlock =
    errors.length > 0
      ? `\n\n### Verbatim error outputs preserved from compacted history\n\n` +
        errors.map((e) => "```\n" + e + "\n```").join("\n\n")
      : "";

  const originalTaskBlock = originalTask
    ? `\n\n**Original task** (verbatim):\n${originalTask
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n")}\n`
    : "";

  const summaryMessage: Message = {
    role: "user",
    parts: [
      {
        type: "text",
        text: `[Session context compacted — earlier conversation summarized]${originalTaskBlock}\n${summary}${errorBlock}`,
      },
    ],
  };

  context.restoreMessages([summaryMessage, ...tail]);

  return { messagesRemoved: head.length, summaryLength: summary.length };
}
