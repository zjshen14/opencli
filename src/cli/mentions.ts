import { readFile, readdir, stat } from "node:fs/promises";
import { join, isAbsolute, relative, extname } from "node:path";

const MAX_FILE_CHARS = 50_000;
const MAX_GLOB_FILES = 20;
const MAX_GLOB_CHARS = 200_000;

/**
 * Expand @path references in user input before sending to the LLM.
 * @path resolves relative to cwd; glob patterns (*, ?) expand to all matching files.
 * Non-resolving tokens that look like file paths emit a warning to stderr and are
 * left verbatim. Tokens that look like @user or @TODO are left silently unchanged.
 */
export async function expandMentions(input: string, cwd: string): Promise<string> {
  const parts: string[] = [];
  let lastIndex = 0;
  const re = /@(\S+)/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(input)) !== null) {
    parts.push(input.slice(lastIndex, m.index));
    const token = m[1];
    const expanded = await tryExpand(token, cwd);
    if (expanded !== null) {
      parts.push(expanded);
    } else {
      if (looksLikeFilePath(token)) {
        process.stderr.write(`\x1b[33mwarn: @${token} — file not found\x1b[0m\n`);
      }
      parts.push(m[0]);
    }
    lastIndex = m.index + m[0].length;
  }
  parts.push(input.slice(lastIndex));
  return parts.join("");
}

function looksLikeFilePath(token: string): boolean {
  return token.includes("/") || extname(token).length > 0;
}

async function tryExpand(token: string, cwd: string): Promise<string | null> {
  if (token.includes("*") || token.includes("?")) {
    return resolveGlob(token, cwd);
  }
  return resolveFile(token, cwd);
}

async function resolveFile(token: string, cwd: string): Promise<string | null> {
  const filePath = isAbsolute(token) ? token : join(cwd, token);
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return null;
    const raw = await readFile(filePath, "utf8");
    const body = raw.slice(0, MAX_FILE_CHARS);
    const truncNote = raw.length > MAX_FILE_CHARS ? `\n[truncated at ${MAX_FILE_CHARS} chars]` : "";
    return `\n\`\`\`\n// ${token}\n${body}${truncNote}\n\`\`\`\n`;
  } catch {
    return null;
  }
}

async function resolveGlob(pattern: string, cwd: string): Promise<string | null> {
  try {
    const allFiles = await walk(cwd);
    const matched = allFiles
      .filter((f) => matchGlob(pattern, relative(cwd, f)))
      .slice(0, MAX_GLOB_FILES);

    if (matched.length === 0) return null;

    const blocks: string[] = [];
    let totalChars = 0;

    for (const filePath of matched) {
      if (totalChars >= MAX_GLOB_CHARS) break;
      try {
        const raw = await readFile(filePath, "utf8");
        const remaining = MAX_GLOB_CHARS - totalChars;
        const body = raw.slice(0, Math.min(MAX_FILE_CHARS, remaining));
        const rel = relative(cwd, filePath);
        blocks.push(`\`\`\`\n// ${rel}\n${body}\n\`\`\``);
        totalChars += body.length;
      } catch {
        // skip unreadable files
      }
    }

    return blocks.length > 0 ? "\n" + blocks.join("\n") + "\n" : null;
  } catch {
    return null;
  }
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walk(full)));
    } else {
      results.push(full);
    }
  }
  return results;
}

function matchGlob(pattern: string, filePath: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "§DSTAR§")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/§DSTAR§\//g, "(?:.+/)?")
        .replace(/§DSTAR§/g, ".*") +
      "$",
  );
  return regex.test(filePath);
}
