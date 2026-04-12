/**
 * Session management — stores per-session conversation logs as JSONL files.
 *
 * Storage layout (mirrors Claude Code's pattern):
 *   ~/.gemini-agent/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * The project path is encoded by replacing path separators with dashes so it
 * can be used as a directory name. Sessions are never written to the project
 * directory itself, keeping the workspace clean.
 *
 * Session ID: YYYY-MM-DDTHH-mm-ss — human-readable, lexicographically sortable,
 * no collision risk (users can't start two sessions in the same second).
 */

import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Path encoding ─────────────────────────────────────────────────────────────

/** Encode an absolute path into a filesystem-safe directory name. */
function encodeProjectPath(cwd: string): string {
  // Replace every "/" with "-"; leading "-" is intentional (matches Claude Code)
  return cwd.replace(/\//g, "-");
}

// ── Session ID ────────────────────────────────────────────────────────────────

function makeSessionId(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return [
    now.getFullYear(),
    "-",
    pad(now.getMonth() + 1),
    "-",
    pad(now.getDate()),
    "T",
    pad(now.getHours()),
    "-",
    pad(now.getMinutes()),
    "-",
    pad(now.getSeconds()),
  ].join("");
}

// ── Session ───────────────────────────────────────────────────────────────────

export interface SessionEntry {
  type: string;
  timestamp: string;
  [key: string]: unknown;
}

export class Session {
  readonly id: string;
  private readonly logPath: string;

  private constructor(id: string, logPath: string) {
    this.id = id;
    this.logPath = logPath;
  }

  /** Create a new session for the given working directory. */
  static async create(cwd: string = process.cwd()): Promise<Session> {
    const id = makeSessionId();
    const projectDir = join(homedir(), ".gemini-agent", "projects", encodeProjectPath(cwd));
    await mkdir(projectDir, { recursive: true });
    const logPath = join(projectDir, `${id}.jsonl`);

    const session = new Session(id, logPath);
    await session.log({ type: "session_start", cwd });
    return session;
  }

  /** Append a structured entry to the JSONL log (non-fatal on failure). */
  async log(entry: Omit<SessionEntry, "timestamp">): Promise<void> {
    try {
      const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + "\n";
      await appendFile(this.logPath, line, "utf8");
    } catch {
      // Non-fatal — session logging should never crash the agent
    }
  }
}
