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
  // Queue of call IDs (and their thoughtSignatures) waiting for their matching results;
  // ensures each function_result references the same ID as its function_call (required by
  // the Anthropic API) and echoes back thoughtSignature (required by Gemini thinking models).
  let pendingCallIds: string[] = [];
  let pendingCallSignatures: (string | undefined)[] = [];

  function flushCalls(): void {
    if (pendingCalls.length === 0) return;
    messages.push({ role: "model", parts: pendingCalls });
    pendingCalls = [];
    // pendingCallIds intentionally kept — results still need them
  }

  function flushResults(): void {
    if (pendingResults.length === 0) return;
    messages.push({ role: "user", parts: pendingResults });
    pendingResults = [];
    pendingCallIds = [];
    pendingCallSignatures = [];
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
      pendingCallIds.push(id);
      pendingCallSignatures.push(entry.thoughtSignature);
      pendingCalls.push({
        type: "function_call",
        id,
        name: entry.name,
        args: entry.args,
        thoughtSignature: entry.thoughtSignature,
      });
    } else if (entry.type === "tool_result") {
      // Results follow their calls — flush the pending call batch into a model message
      flushCalls();
      const id = pendingCallIds.shift() ?? `resume-call-${++idCounter}`;
      const resultSignature = pendingCallSignatures.shift();
      pendingResults.push({
        type: "function_result",
        id,
        name: entry.name,
        result: entry.result,
        thoughtSignature: resultSignature,
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

  return messages;
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
    const raw = await readFile(logPath, "utf8");
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
