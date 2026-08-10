import chalk from "chalk";
import type { ConfirmFn } from "../core/executor.js";
import { loadConfig, saveConfig, type Config } from "../state/config.js";
import { loadSettings, type Settings } from "../state/settings.js";
import { selectKey } from "./input.js";

// Pattern format for deny rules: "toolName(argGlob)" where * matches any chars.
// bash → matches args.command; write/edit/multi_edit → args.file_path; others → JSON(args).
// Example: "bash(rm -rf *)" or "write(src/cli/*)" or "bash(*)" (all bash).

export function globMatch(pattern: string, str: string): boolean {
  const re = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
  return re.test(str);
}

export function matchesDenyPattern(
  patterns: string[],
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  const primaryArg =
    toolName === "bash"
      ? String(args.command ?? "")
      : toolName === "write" || toolName === "edit" || toolName === "multi_edit"
        ? String(args.file_path ?? "")
        : JSON.stringify(args);

  for (const pattern of patterns) {
    const parenOpen = pattern.indexOf("(");
    if (parenOpen === -1 || !pattern.endsWith(")")) continue;

    const patTool = pattern.slice(0, parenOpen);
    const patArg = pattern.slice(parenOpen + 1, -1);

    if (patTool === toolName && globMatch(patArg, primaryArg)) return true;
  }
  return false;
}

/** Builds a sync function that returns true when a tool call matches one of the
 *  given ask patterns and must therefore be confirmed even if the tool's own
 *  requiresConfirmation would return false. */
export function createForcesConfirmationFn(
  askPatterns: string[],
): (toolName: string, args: Record<string, unknown>) => boolean {
  return (toolName, args) => {
    if (askPatterns.length === 0) return false;
    return matchesDenyPattern(askPatterns, toolName, args);
  };
}

export interface PermissionSources {
  /** Trusted grants — only ever sourced from the user's global config. */
  globalAllowSet: Set<string>;
  /** Merged deny patterns (global + project). Restrictive rules are safe to accept
   *  from project scope because they can only block, never grant. */
  denyPatterns: string[];
  /** Merged ask patterns (global + project). */
  askPatterns: string[];
}

/**
 * Build the permission sources used by the HITL gate.
 *
 * Grants (`allow`) are sourced ONLY from the user's global `~/.opencli/config.json`.
 * Project-scoped `.opencli/settings.json` ships with the repository and is therefore
 * untrusted: a hostile repo could pre-populate `permissions.allow` to silently bypass
 * the confirmation gate (GHSA-3g98-ffw6-87mg). Restrictive rules (`ask`, `deny`) are
 * still merged from project scope — they can only prompt or block, never auto-approve.
 */
export function buildPermissionSources(config: Config, settings: Settings): PermissionSources {
  return {
    globalAllowSet: new Set(config.permissions?.allow ?? []),
    denyPatterns: [...(config.permissions?.deny ?? []), ...(settings.permissions?.deny ?? [])],
    askPatterns: [...(config.permissions?.ask ?? []), ...(settings.permissions?.ask ?? [])],
  };
}

export type ConfirmDecision = "allow" | "deny" | "ask";

/**
 * Returns a stderr warning when the project-scoped `.opencli/settings.json` carries
 * `allow` entries that are intentionally ignored (they ship with the repo and are
 * untrusted — see GHSA-3g98-ffw6-87mg). This explains why a user's pre-existing
 * project grants stopped working and surfaces a repo attempting the attack.
 * Restrictive `ask`/`deny` from project scope are still honoured, so not flagged.
 */
export function ignoredProjectAllowWarning(settings: Settings): string | null {
  const n = settings.permissions?.allow?.length ?? 0;
  if (n === 0) return null;
  return (
    `[opencli] ignoring ${n} project-scoped allow rule(s) in .opencli/settings.json — ` +
    "grants must be global (~/.opencli/config.json)."
  );
}

/**
 * Pure policy check for a tool call.
 *  - "allow": globally pre-approved; no prompt needed.
 *  - "deny":  blocked by a deny pattern, or non-interactive and not pre-approved.
 *  - "ask":   interactive and requires a prompt.
 *
 * Only the trusted `globalAllowSet` is consulted for grants; project-scope allow
 * entries never reach this function (see buildPermissionSources).
 */
export function decideConfirmation(
  globalAllowSet: Set<string>,
  denyPatterns: string[],
  toolName: string,
  args: Record<string, unknown>,
  interactive: boolean,
): ConfirmDecision {
  if (!interactive) return "deny";
  if (denyPatterns.length > 0 && matchesDenyPattern(denyPatterns, toolName, args)) {
    return "deny";
  }
  const exactKey = `${toolName}:${JSON.stringify(args)}`;
  if (globalAllowSet.has(exactKey) || globalAllowSet.has(`${toolName}:*`)) return "allow";
  const mcpMatch = toolName.match(/^mcp__(.+?)__/);
  if (mcpMatch && globalAllowSet.has(`mcp__${mcpMatch[1]}__*`)) return "allow";
  return "ask";
}

export interface ConfirmBundle {
  confirmFn: ConfirmFn;
  /** Returns true if the tool call matches an `ask` pattern and must be confirmed
   *  even when the tool itself does not set requiresConfirmation. */
  forcesConfirmation: (toolName: string, args: Record<string, unknown>) => boolean;
}

export async function createConfirmFn(): Promise<ConfirmBundle> {
  const [config, settings] = await Promise.all([loadConfig(), loadSettings()]);
  const { globalAllowSet, denyPatterns, askPatterns } = buildPermissionSources(config, settings);

  // Signal when the project ships allow entries we are intentionally ignoring. This
  // both explains why a user's pre-existing grants stopped working (debugging) and
  // flags a repo attempting the GHSA-3g98-ffw6-87mg attack. ask/deny from project
  // scope are still honoured (restrictive), so they are not flagged.
  const warn = ignoredProjectAllowWarning(settings);
  if (warn) process.stderr.write(chalk.dim(warn + "\n"));

  const forcesConfirmation = createForcesConfirmationFn(askPatterns);

  // Persist an "always allow" grant to the user's global config. Grants are never
  // written to project-scoped settings.json — that file ships with the repo and
  // must not carry auto-approve authority (GHSA-3g98-ffw6-87mg).
  const persistGlobalAllow = async (key: string): Promise<void> => {
    globalAllowSet.add(key);
    const cfg = await loadConfig();
    await saveConfig({ permissions: { ...cfg.permissions, allow: [...globalAllowSet] } });
  };

  const confirmFn: ConfirmFn = async (toolName, args) => {
    const interactive = process.stdin.isTTY === true;
    const decision = decideConfirmation(globalAllowSet, denyPatterns, toolName, args, interactive);
    if (decision === "allow") return "allow";
    if (decision === "deny") return "deny";

    // decision === "ask" — interactive prompt.
    const detail =
      toolName === "bash"
        ? (args.command as string)
        : toolName === "write" || toolName === "edit" || toolName === "multi_edit"
          ? (args.file_path as string)
          : JSON.stringify(args);

    process.stderr.write(chalk.yellow(`\n  ⚠  ${toolName} requires confirmation\n`));
    process.stderr.write(chalk.dim(`     ${detail}\n`));

    const isMcp = toolName.startsWith("mcp__");
    const mcpMatch = toolName.match(/^mcp__(.+?)__/);
    const options: Array<{ key: string; label: string }> = [
      { key: "y", label: "Yes, run once" },
      { key: "g", label: "Yes, always (saved to global ~/.opencli/config.json)" },
    ];
    if (isMcp) {
      options.push({ key: "t", label: "Yes, always for this tool, any args  (global)" });
      if (mcpMatch) {
        options.push({
          key: "s",
          label: `Yes, always for any tool from '${mcpMatch[1]}'  (global)`,
        });
      }
    }
    options.push({ key: "n", label: "No, skip" });

    const choice = await selectKey(`Allow ${toolName}?`, options);

    if (choice === null || choice === "n") return "deny";

    if (choice === "g") {
      await persistGlobalAllow(`${toolName}:${JSON.stringify(args)}`);
    } else if (choice === "t") {
      await persistGlobalAllow(`${toolName}:*`);
    } else if (choice === "s" && mcpMatch) {
      await persistGlobalAllow(`mcp__${mcpMatch[1]}__*`);
    }

    return "allow";
  };

  return { confirmFn, forcesConfirmation };
}
