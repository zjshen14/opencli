/**
 * Session management — stores per-session conversation logs as JSONL files.
 *
 * Storage layout (mirrors Claude Code's pattern):
 *   ~/.opencli/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * Sessions are never written to the project directory itself, keeping the
 * workspace clean. The project path is encoded using base64url to prevent collisions.
 *
 * Session ID: YYYY-MM-DDTHH-mm-ss-SSS — human-readable, lexicographically sortable,
 * millisecond precision to prevent collisions.
 */

import { mkdir, appendFile, readdir, readFile, stat, rename } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { AGENT_DIR } from "./config.js";
import type { FunctionCallPart, FunctionResultPart, Message } from "../providers/types.js";

function encodeProjectPath(cwd: string): string {
  return Buffer.from(cwd).toString("base64url");
}

function makeSessionId(): string {
  return new Date().toISOString().slice(0, 23).replace(/[:.]/g, "-");
}

async function sessionProjectDir(cwd: string): Promise<string> {
  const newDir = join(AGENT_DIR, "projects", encodeProjectPath(cwd));
  const oldDir = join(AGENT_DIR, "projects", cwd.replace(/\//g, "-"));

  if (newDir !== oldDir) {
    try {
      const oldStats = await stat(oldDir);
      if (oldStats.isDirectory()) {
        let newExists = false;
        try {
          await stat(newDir);
          newExists = true;
        } catch {
          // newDir doesn't exist
        }

        if (!newExists) {
          // Rename old to new if new doesn't exist
          await rename(oldDir, newDir);
        } else {
          // Merge: move each old session file into the new dir
          try {
            const files = await readdir(oldDir);
            await Promise.all(
              files
                .filter((f) => f.endsWith(".jsonl"))
                .map((f) =>
                  rename(join(oldDir, f), join(newDir, f)).catch(() => {
                    /* ignore rename errors */
                  }),
                ),
            );
          } catch {
            /* ignore read errors */
          }
        }
      }
    } catch {
      // Old directory doesn't exist, no migration needed
    }
  }
  return newDir;
}

/** List JSONL session files for a project dir, newest first. Returns [] on ENOENT. */
async function listSessionFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Read only until the first "user" entry, returning the content (max 80 chars). */
async function readFirstUserMessage(logPath: string): Promise<string> {
  try {
    const rl = createInterface({ input: createReadStream(logPath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.type === "user" && typeof entry.content === "string") {
        rl.close();
        return entry.content.slice(0, 80);
      }
    }
  } catch {
    // ignore — missing or malformed file
  }
  return "";
}

/**
 * Reconstruct a Message[] from session log entries.
 *
 * The JSONL stores events in emission order:
 *   user → tool_call* → tool_result* → (tool_call* → tool_result*)* → assistant
 *
 * We group consecutive tool_calls into the model message that requested them,
 * and consecutive tool_results into the user message that delivers them back.
 * Synthetic IDs are assigned sequentially so each FunctionCallPart/FunctionResultPart
 * pair is consistent (Gemini requires matching IDs but doesn't validate them on replay).
 */
function reconstructMessages(entries: SessionEntry[]): Message[] {
  const messages: Message[] = [];
  let idCounter = 0;

  // Pending batches accumulate until we know where they belong
  let pendingCalls: FunctionCallPart[] = [];
  let pendingResults: FunctionResultPart[] = [];
  // Queue of pending calls' (id, signature) pairs waiting for their matching
  // results. The id pair is required by Anthropic's tool_use_id contract; the
  // signature is needed so Gemini thinking-model functionResponse can echo it.
  let pendingCallMeta: { id: string; thoughtSignature?: string }[] = [];

  function flushCalls(): void {
    if (pendingCalls.length === 0) return;
    messages.push({ role: "model", parts: pendingCalls });
    pendingCalls = [];
    // pendingCallMeta intentionally kept — results still need it
  }

  function flushResults(): void {
    if (pendingResults.length === 0) return;
    messages.push({ role: "user", parts: pendingResults });
    pendingResults = [];
    pendingCallMeta = [];
  }

  for (const entry of entries) {
    if (entry.type === "user") {
      // A new user turn — flush any dangling tool state first
      flushCalls();
      flushResults();
      messages.push({ role: "user", parts: [{ type: "text", text: entry.content }] });
    } else if (entry.type === "tool_call") {
      // New tool_call batch: if there were results from a previous round, flush them first
      flushResults();
      const id = `resume-call-${++idCounter}`;
      pendingCallMeta.push({ id, thoughtSignature: entry.thoughtSignature });
      pendingCalls.push({
        type: "function_call",
        id,
        name: entry.name,
        args: entry.args,
        ...(entry.thoughtSignature ? { thoughtSignature: entry.thoughtSignature } : {}),
      });
    } else if (entry.type === "tool_result") {
      // Results follow their calls — flush the pending call batch into a model message
      flushCalls();
      if (pendingCallMeta.length === 0) {
        process.stderr.write(
          `[opencli] warn: orphaned tool_result for "${entry.name}" (no matching tool_call) — skipping\n`,
        );
        continue;
      }
      const meta = pendingCallMeta.shift()!;
      pendingResults.push({
        type: "function_result",
        id: meta.id,
        name: entry.name,
        result: entry.result,
        // Echo the paired call's signature so Gemini thinking-model
        // functionResponse can carry it on the next request.
        ...(meta.thoughtSignature ? { thoughtSignature: meta.thoughtSignature } : {}),
      });
    } else if (entry.type === "assistant" && entry.content) {
      flushCalls();
      flushResults();
      messages.push({ role: "model", parts: [{ type: "text", text: entry.content }] });
    }
    // session_start and unrecognised types are silently ignored
  }

  // Flush anything left over (e.g. session ended mid-turn)
  flushCalls();
  flushResults();

  return collapseConsecutiveUserText(messages);
}

/**
 * Merge consecutive `role: "user"` text-only messages into one.
 *
 * Older JSONL logs may contain back-to-back `user` entries — typically because
 * a REPL-only slash command like `/exit` was persisted before being intercepted,
 * or because the agent crashed mid-turn so no `assistant` event followed the
 * user input. Replaying them as separate messages violates provider role
 * alternation (Gemini/Anthropic both 400 on consecutive same-role contents).
 * Merging the text preserves the user's words without breaking the wire format.
 *
 * Only collapses *text-only* user messages — user messages carrying
 * `function_result` parts must remain distinct (they pair with prior tool
 * calls and merging would orphan them).
 */
function collapseConsecutiveUserText(messages: Message[]): Message[] {
  const result: Message[] = [];
  for (const msg of messages) {
    const last = result[result.length - 1];
    if (last && isUserTextOnly(last) && isUserTextOnly(msg)) {
      const mergedText =
        last.parts.map((p) => (p as { type: "text"; text: string }).text).join("\n\n") +
        "\n\n" +
        msg.parts.map((p) => (p as { type: "text"; text: string }).text).join("\n\n");
      result[result.length - 1] = {
        role: "user",
        parts: [{ type: "text", text: mergedText }],
      };
    } else {
      result.push(msg);
    }
  }
  return result;
}

function isUserTextOnly(msg: Message): boolean {
  return msg.role === "user" && msg.parts.length > 0 && msg.parts.every((p) => p.type === "text");
}

export type SessionEntry =
  | { type: "session_start"; timestamp: string; cwd: string }
  | { type: "user"; timestamp: string; content: string }
  | { type: "assistant"; timestamp: string; content: string }
  | {
      type: "tool_call";
      timestamp: string;
      name: string;
      args: Record<string, unknown>;
      // Gemini thinking-model signature for the originating functionCall.
      // Persisted so a resumed session sends the same structured payload as an
      // unbroken one; reconstructMessages propagates it onto the FunctionCallPart
      // and the matching FunctionResultPart.
      thoughtSignature?: string;
    }
  | { type: "tool_result"; timestamp: string; name: string; result: string };

type WithoutTimestamp<T> = T extends unknown ? Omit<T, "timestamp"> : never;

export interface SessionSummary {
  id: string;
  firstUserMessage: string;
}

export class Session {
  readonly id: string;
  readonly cwd: string;
  private readonly logPath: string;

  private constructor(id: string, cwd: string, logPath: string) {
    this.id = id;
    this.cwd = cwd;
    this.logPath = logPath;
  }

  /** Scratch directory for agent-generated temporary files, scoped to this session. */
  get tmpDir(): string {
    return join(this.cwd, ".opencli", "tmp", this.id);
  }

  static async create(cwd: string = process.cwd()): Promise<Session> {
    const id = makeSessionId();
    const dir = await sessionProjectDir(cwd);
    await mkdir(dir, { recursive: true });
    const logPath = join(dir, `${id}.jsonl`);
    const session = new Session(id, cwd, logPath);
    await session.log({ type: "session_start", cwd });
    return session;
  }

  /**
   * List sessions for the current directory, newest first.
   * Returns up to `limit` entries with the first user message as a preview.
   */
  static async list(cwd: string = process.cwd(), limit = 20): Promise<SessionSummary[]> {
    const dir = await sessionProjectDir(cwd);
    const files = (await listSessionFiles(dir)).slice(0, limit);
    return Promise.all(
      files.map(async (file) => ({
        id: file.replace(".jsonl", ""),
        firstUserMessage: await readFirstUserMessage(join(dir, file)),
      })),
    );
  }

  /**
   * Load conversation messages from a session JSONL for resuming.
   * Pass "latest" to resume the most recent session that has conversation content.
   */
  static async loadMessages(
    id: string,
    cwd: string = process.cwd(),
  ): Promise<{ session: Session; messages: Message[] }> {
    const dir = await sessionProjectDir(cwd);

    let sessionId = id;
    if (id === "latest") {
      const files = await listSessionFiles(dir);
      if (files.length === 0) throw new Error("No sessions found for this directory.");
      let found = false;
      for (const file of files) {
        const msg = await readFirstUserMessage(join(dir, file));
        if (msg) {
          sessionId = file.replace(".jsonl", "");
          found = true;
          break;
        }
      }
      if (!found) throw new Error("No sessions with conversation content found.");
    }

    const logPath = join(dir, `${sessionId}.jsonl`);
    let raw: string;
    try {
      raw = await readFile(logPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Session '${sessionId}' not found for this directory. Run 'opencli sessions' to list available sessions.`,
          { cause: err },
        );
      }
      throw err;
    }
    const entries: SessionEntry[] = raw
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as SessionEntry];
        } catch {
          process.stderr.write("[opencli] skipping malformed session log entry\n");
          return [];
        }
      });

    return {
      session: new Session(sessionId, cwd, logPath),
      messages: reconstructMessages(entries),
    };
  }

  async log(entry: WithoutTimestamp<SessionEntry>): Promise<void> {
    try {
      const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + "\n";
      await appendFile(this.logPath, line, "utf8");
    } catch {
      // Non-fatal — session logging should never crash the agent
    }
  }
}
