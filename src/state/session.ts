/**
 * Session management — stores per-session conversation logs as JSONL files.
 *
 * Storage layout (mirrors Claude Code's pattern):
 *   ~/.gemini-agent/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * Sessions are never written to the project directory itself, keeping the
 * workspace clean. The project path is encoded by replacing "/" with "-".
 *
 * Session ID: YYYY-MM-DDTHH-mm-ss — human-readable, lexicographically sortable,
 * no collision risk (users can't start two sessions in the same second).
 */

import { mkdir, appendFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_DIR } from "./config.js";
import type { Message } from "../model/types.js";

function encodeProjectPath(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

function makeSessionId(): string {
  return new Date().toISOString().slice(0, 19).replace(/:/g, "-");
}

function projectDir(cwd: string): string {
  return join(AGENT_DIR, "projects", encodeProjectPath(cwd));
}

export interface SessionEntry {
  type: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface SessionSummary {
  id: string;
  timestamp: string;
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
    return join(this.cwd, ".gemini-agent", "tmp", this.id);
  }

  static async create(cwd: string = process.cwd()): Promise<Session> {
    const id = makeSessionId();
    const dir = projectDir(cwd);
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
    const dir = projectDir(cwd);
    let files: string[];
    try {
      files = (await readdir(dir))
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse();
    } catch {
      return [];
    }

    const summaries: SessionSummary[] = [];
    for (const file of files.slice(0, limit)) {
      const id = file.replace(".jsonl", "");
      const firstUserMessage = await readFirstUserMessage(join(dir, file));
      summaries.push({
        id,
        timestamp: id.replace("T", " ").replace(/-/g, (_, o) => (o < 10 ? "-" : ":")),
        firstUserMessage,
      });
    }
    return summaries;
  }

  /**
   * Load conversation messages from a session JSONL for resuming.
   * Returns the most recent session if id is "latest".
   */
  static async loadMessages(
    id: string,
    cwd: string = process.cwd(),
  ): Promise<{ session: Session; messages: Message[] }> {
    const dir = projectDir(cwd);

    let sessionId = id;
    if (id === "latest") {
      // Pick the most recent session that has at least one user message
      const files = (await readdir(dir))
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse();
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
      .map((line) => JSON.parse(line));

    // Reconstruct conversation as alternating user/model messages.
    // Tool calls/results are omitted — the text content is sufficient for context.
    const messages: Message[] = [];
    for (const entry of entries) {
      if (entry.type === "user" && typeof entry.content === "string") {
        messages.push({ role: "user", parts: [{ type: "text", text: entry.content }] });
      } else if (entry.type === "assistant" && typeof entry.content === "string" && entry.content) {
        messages.push({ role: "model", parts: [{ type: "text", text: entry.content }] });
      }
    }

    const session = new Session(sessionId, cwd, logPath);
    return { session, messages };
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

async function readFirstUserMessage(logPath: string): Promise<string> {
  try {
    const raw = await readFile(logPath, "utf8");
    for (const line of raw.split("\n").filter(Boolean)) {
      const entry = JSON.parse(line);
      if (entry.type === "user" && typeof entry.content === "string") {
        return entry.content.slice(0, 80);
      }
    }
  } catch {
    // ignore
  }
  return "";
}
