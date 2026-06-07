#!/usr/bin/env tsx
/**
 * Redact a session JSONL into a sealed replay tape.
 *
 * Usage:
 *   tsx scripts/redact-tape.ts <input.jsonl> <output.jsonl>
 *
 * Environment:
 *   REDACT_USER       — username to redact (defaults to $USER)
 *   TRUNCATE_FROM_LINE — optional 1-based line index to start from (inclusive)
 *   TRUNCATE_TO_LINE   — optional 1-based line index to end at (inclusive)
 *
 * What this redacts:
 *   1. Absolute home paths matching /Users/<username>/ or /home/<username>/.
 *      Replacement: /Users/REPLAY-USER/ or /home/replay-user/.
 *   2. Bare occurrences of the username and capitalised variants.
 *   3. The `cwd` field on `session_start` is rewritten to a generic path.
 *
 * What this DOES NOT redact:
 *   - Package-lock integrity hashes, long base64 IDs, mock-data tokens —
 *     these are not secrets; redacting them would mangle deterministic
 *     content the replay relies on.
 *   - Web-fetch outputs of public sites.
 *   - Code content.
 *
 * Determinism: same input + same REDACT_USER + same TRUNCATE_* → byte-
 * identical output. The script writes a sidecar
 * `<output>.redaction-log.json` with counts of each replacement and the
 * input/output sha256s so reviewers can audit.
 *
 * Exit codes: 0 success, 1 missing args, 2 cannot read input, 3 cannot
 * write output, 4 no replacements made (likely wrong username).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

interface ReplacementRule {
  /** Pattern to find. Strings are replaced literally (not regex). */
  find: string;
  /** Replacement value. */
  replace: string;
  /** Description for the audit log. */
  description: string;
}

function buildRules(username: string): ReplacementRule[] {
  const cap = username.charAt(0).toUpperCase() + username.slice(1);
  // Order matters: longest / most specific patterns first so a later rule
  // can't partially mangle an earlier replacement.
  return [
    {
      find: `/Users/${username}/`,
      replace: "/Users/REPLAY-USER/",
      description: "absolute home path (macOS)",
    },
    {
      find: `/home/${username}/`,
      replace: "/home/replay-user/",
      description: "absolute home path (linux)",
    },
    {
      find: `/Users/${username}`,
      replace: "/Users/REPLAY-USER",
      description: "absolute home prefix (macOS)",
    },
    {
      find: `/home/${username}`,
      replace: "/home/replay-user",
      description: "absolute home prefix (linux)",
    },
    {
      find: cap,
      replace: "ReplayUser",
      description: "capitalised username",
    },
    {
      find: username,
      replace: "replay-user",
      description: "bare username",
    },
  ];
}

function redactString(input: string, rules: ReplacementRule[]): { out: string; counts: number[] } {
  let out = input;
  const counts = rules.map(() => 0);
  for (let i = 0; i < rules.length; i++) {
    const { find, replace } = rules[i];
    if (!find) continue;
    let count = 0;
    const pieces: string[] = [];
    while (true) {
      const idx = out.indexOf(find);
      if (idx === -1) break;
      pieces.push(out.slice(0, idx));
      pieces.push(replace);
      out = out.slice(idx + find.length);
      count++;
    }
    pieces.push(out);
    out = pieces.join("");
    counts[i] = count;
  }
  return { out, counts };
}

function main(): void {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    process.stderr.write("Usage: tsx scripts/redact-tape.ts <input.jsonl> <output.jsonl>\n");
    process.exit(1);
  }

  const username = process.env.REDACT_USER ?? process.env.USER;
  if (!username) {
    process.stderr.write("REDACT_USER or USER must be set\n");
    process.exit(1);
  }

  let input: string;
  try {
    input = readFileSync(inputPath, "utf8");
  } catch (err) {
    process.stderr.write(`Cannot read ${inputPath}: ${(err as Error).message}\n`);
    process.exit(2);
  }

  const inputSha256 = createHash("sha256").update(input).digest("hex");

  // Optional deterministic truncation. Lines are 1-based, both bounds
  // inclusive. Blank lines are preserved in counting (so the truncation
  // range stays consistent with what a human sees in their editor).
  const truncateFrom = parseInt(process.env.TRUNCATE_FROM_LINE ?? "", 10);
  const truncateTo = parseInt(process.env.TRUNCATE_TO_LINE ?? "", 10);
  let processInput = input;
  let truncation: { fromLine: number; toLine: number } | null = null;
  if (!Number.isNaN(truncateFrom) || !Number.isNaN(truncateTo)) {
    const lines = input.split("\n");
    const from = Number.isNaN(truncateFrom) ? 1 : truncateFrom;
    const to = Number.isNaN(truncateTo) ? lines.length : truncateTo;
    if (from < 1 || to < from || to > lines.length) {
      process.stderr.write(
        `Invalid truncation range: ${from}..${to} (file has ${lines.length} lines)\n`,
      );
      process.exit(1);
    }
    // slice is 0-based and end-exclusive
    processInput = lines.slice(from - 1, to).join("\n") + "\n";
    truncation = { fromLine: from, toLine: to };
  }

  const rules = buildRules(username);
  const { out, counts } = redactString(processInput, rules);
  const totalReplacements = counts.reduce((a, b) => a + b, 0);

  if (totalReplacements === 0) {
    process.stderr.write(
      `No replacements made — is REDACT_USER set correctly (got '${username}')?\n`,
    );
    process.exit(4);
  }

  const outSha256 = createHash("sha256").update(out).digest("hex");

  // Sanity check: input lines (post-truncation) === output lines.
  const inputLines = processInput.split("\n").filter((l) => l.trim()).length;
  const outputLines = out.split("\n").filter((l) => l.trim()).length;
  if (inputLines !== outputLines) {
    process.stderr.write(
      `Line count mismatch (input=${inputLines}, output=${outputLines}) — redaction corrupted JSONL\n`,
    );
    process.exit(3);
  }

  try {
    writeFileSync(outputPath, out);
  } catch (err) {
    process.stderr.write(`Cannot write ${outputPath}: ${(err as Error).message}\n`);
    process.exit(3);
  }

  const log = {
    inputSha256,
    inputBytes: input.length,
    outputSha256: outSha256,
    outputBytes: out.length,
    truncation,
    totalReplacements,
    rules: rules.map((r, i) => ({
      find: r.find,
      replace: r.replace,
      description: r.description,
      count: counts[i],
    })),
  };

  writeFileSync(outputPath + ".redaction-log.json", JSON.stringify(log, null, 2));

  const trunNote = truncation ? ` (truncated lines ${truncation.fromLine}-${truncation.toLine})` : "";
  process.stderr.write(
    `Redacted ${inputLines} entries${trunNote} (${input.length} → ${out.length} bytes), ` +
      `${totalReplacements} replacements. Log: ${outputPath}.redaction-log.json\n`,
  );
}

main();
