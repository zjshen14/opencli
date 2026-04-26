/**
 * Session management — stores per-session conversation logs as JSONL files.
 *
 * Storage layout (mirrors Claude Code's pattern):
 *   ~/.opencli/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * Sessions are never written to the project directory itself, keeping the
 * workspace clean. The project path is encoded by replacing "/" with "-".
 *
 * Session ID: YYYY-MM-DDTHH-mm-ss — human-readable, lexicographically sortable,
 * no collision risk (users can't start two sessions in the same second).
 */

import { mkdir, appendFile, readdir, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { AGENT_DIR } from "./config.js";
import type { FunctionCallPart, FunctionResultPart, Message } from "../model/types.js";

function encodeProjectPath(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

function makeSessionId(): string {
  return new Date().toISOString().slice(0, 19).replace(/:/g, "-");
}

function sessionProjectDir(cwd: string): string {
  return join(AGENT_DIR, "projects", encodeProjectPath(cwd));
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

  function flushCalls(): void {
    if (pendingCalls.length === 0) return;
    messages.push({ role: "model", parts: pendingCalls });
    pendingCalls = [];
  }

  function flushResults(): void {
    if (pendingResults.length === 0) return;
    messages.push({ role: "user", parts: pendingResults });
    pendingResults = [];
  }

  for (const entry of entries) {
    if (entry.type === "user" && typeof entry.content === "string") {
      // A new user turn — flush any dangling tool state first
      flushCalls();
      flushResults();
      messages.push({ role: "user", parts: [{ type: "text", text: entry.content }] });
    } else if (entry.type === "tool_call") {
      // New tool_call batch: if there were results from a previous round, flush them first
      flushResults();
      const id = `resume-call-${++idCounter}`;
      pendingCalls.push({
        type: "function_call",
        id,
        name: String(entry.name ?? ""),
        args: (entry.args as Record<string, unknown>) ?? {},
      });
    } else if (entry.type === "tool_result") {
      // Results follow their calls — flush the pending call batch into a model message
      flushCalls();
      const id = `resume-call-${++idCounter}`;
      pendingResults.push({
        type: "function_result",
        id,
        name: String(entry.name ?? ""),
        result: String(entry.result ?? ""),
      });
    } else if (entry.type === "assistant" && typeof entry.content === "string" && entry.content) {
      flushCalls();
      flushResults();
      messages.push({ role: "model", parts: [{ type: "text", text: entry.content }] });
    }
  }

  // Flush anything left over (e.g. session ended mid-turn)
  flushCalls();
  flushResults();

  return messages;
}

export interface SessionEntry {
  type: string;
  timestamp: string;
  [key: string]: unknown;
}

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
    const dir = sessionProjectDir(cwd);
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
    const dir = sessionProjectDir(cwd);
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
    const dir = sessionProjectDir(cwd);

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

  async log(entry: Omit<SessionEntry, "timestamp">): Promise<void> {
    try {
      const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + "\n";
      await appendFile(this.logPath, line, "utf8");
    } catch {
      // Non-fatal — session logging should never crash the agent
    }
  }
}
