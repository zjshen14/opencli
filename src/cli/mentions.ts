import { readFile, readdir } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";

const MAX_FILE_CHARS = 50_000;
const MAX_GLOB_FILES = 20;
const MAX_GLOB_CHARS = 200_000;

export interface ExpandResult {
  /** Input string with @tokens replaced by file content blocks. */
  expanded: string;
  /** Non-fatal warnings to print before the agent turn. */
  warnings: string[];
}

/**
 * Resolve @path and @glob tokens in `input` against `cwd`.
 * Tokens that do not resolve to readable files are left unchanged and
 * reported in `warnings`. Never throws.
 */
export async function expandMentions(input: string, cwd: string): Promise<ExpandResult> {
  if (!input.includes("@")) return { expanded: input, warnings: [] };

  const regex = /@(\S+)/g;
  const matches = [...input.matchAll(regex)];
  if (matches.length === 0) return { expanded: input, warnings: [] };

  const warnings: string[] = [];
  const replacements: Array<{ start: number; end: number; text: string }> = [];

  for (const match of matches) {
    const token = match[1];
    const start = match.index!;
    const end = start + match[0].length;

    const isGlob = /[*?{[]/.test(token);
    const replacement = isGlob
      ? await expandGlob(token, cwd, warnings)
      : await expandFile(token, cwd, warnings);

    if (replacement !== null) {
      replacements.push({ start, end, text: replacement });
    }
  }

  // Apply replacements in reverse so earlier offsets stay valid.
  let expanded = input;
  for (const r of replacements.reverse()) {
    expanded = expanded.slice(0, r.start) + r.text + expanded.slice(r.end);
  }

  return { expanded, warnings };
}

async function expandFile(token: string, cwd: string, warnings: string[]): Promise<string | null> {
  const filePath = isAbsolute(token) ? token : join(cwd, token);
  let content: string;
  try {
    const buf = await readFile(filePath);
    if (isBinary(buf)) {
      warnings.push(`@${token}: skipped (binary file)`);
      return null;
    }
    content = buf.toString("utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const msg =
      code === "ENOENT" ? "file not found" : err instanceof Error ? err.message : String(err);
    warnings.push(`@${token}: ${msg}`);
    return null;
  }

  let truncNote = "";
  if (content.length > MAX_FILE_CHARS) {
    content = content.slice(0, MAX_FILE_CHARS);
    truncNote = ` (truncated at ${MAX_FILE_CHARS} chars)`;
  }

  return `--- @${token}${truncNote} ---\n${content}\n--- end ---`;
}

async function expandGlob(token: string, cwd: string, warnings: string[]): Promise<string | null> {
  let allFiles: string[];
  try {
    allFiles = await walk(cwd);
  } catch (err) {
    warnings.push(`@${token}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const matched = allFiles.filter((f) => matchGlob(token, relative(cwd, f)));
  if (matched.length === 0) {
    warnings.push(`@${token}: no files matched`);
    return null;
  }

  const blocks: string[] = [];
  let totalChars = 0;
  let capped = false;

  for (const filePath of matched) {
    if (blocks.length >= MAX_GLOB_FILES) {
      capped = true;
      break;
    }

    let content: string;
    try {
      const buf = await readFile(filePath);
      if (isBinary(buf)) {
        warnings.push(`@${relative(cwd, filePath)}: skipped (binary file)`);
        continue;
      }
      content = buf.toString("utf8");
    } catch {
      continue;
    }

    let truncNote = "";
    if (content.length > MAX_FILE_CHARS) {
      content = content.slice(0, MAX_FILE_CHARS);
      truncNote = ` (truncated at ${MAX_FILE_CHARS} chars)`;
    }

    const rel = relative(cwd, filePath);
    const block = `--- @${rel}${truncNote} ---\n${content}\n--- end ---`;

    if (totalChars + block.length > MAX_GLOB_CHARS) {
      capped = true;
      break;
    }

    blocks.push(block);
    totalChars += block.length;
  }

  if (capped) {
    warnings.push(`@${token}: expansion capped at ${blocks.length} files`);
  }

  if (blocks.length === 0) {
    warnings.push(`@${token}: no readable files matched`);
    return null;
  }

  return blocks.join("\n\n");
}

function isBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
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
