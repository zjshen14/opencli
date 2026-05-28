import chalk from "chalk";
import type { ConfirmFn } from "../core/executor.js";
import { loadConfig, saveConfig } from "../state/config.js";
import { loadSettings, saveSettings } from "../state/settings.js";
import { selectKey } from "./input.js";

// Pattern format for deny rules: "toolName(argGlob)" where * matches any chars.
// bash → matches args.command; write/edit → args.file_path; others → JSON(args).
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
      : toolName === "write" || toolName === "edit"
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

export interface ConfirmBundle {
  confirmFn: ConfirmFn;
  /** Returns true if the tool call matches an `ask` pattern and must be confirmed
   *  even when the tool itself does not set requiresConfirmation. */
  forcesConfirmation: (toolName: string, args: Record<string, unknown>) => boolean;
}

export async function createConfirmFn(): Promise<ConfirmBundle> {
  const [config, settings] = await Promise.all([loadConfig(), loadSettings()]);

  const globalAllowSet = new Set<string>(config.permissions?.allow ?? []);
  const projectAllowSet = new Set<string>(settings.permissions?.allow ?? []);
  const denyPatterns: string[] = [
    ...(config.permissions?.deny ?? []),
    ...(settings.permissions?.deny ?? []),
  ];
  const askPatterns: string[] = [
    ...(config.permissions?.ask ?? []),
    ...(settings.permissions?.ask ?? []),
  ];

  const forcesConfirmation = createForcesConfirmationFn(askPatterns);

  const confirmFn: ConfirmFn = async (toolName, args) => {
    if (!process.stdin.isTTY) return "deny";

    if (denyPatterns.length > 0 && matchesDenyPattern(denyPatterns, toolName, args)) {
      return "deny";
    }

    const exactKey = `${toolName}:${JSON.stringify(args)}`;
    const toolWildcard = `${toolName}:*`;

    // Derive MCP server wildcard from name like mcp__<server>__<tool>
    // Use lazy .+? so server names containing _ (e.g. my_server) match correctly.
    const mcpMatch = toolName.match(/^mcp__(.+?)__/);
    const serverWildcard = mcpMatch ? `mcp__${mcpMatch[1]}__*` : null;

    const isAllowed = (key: string) => globalAllowSet.has(key) || projectAllowSet.has(key);

    if (
      isAllowed(exactKey) ||
      isAllowed(toolWildcard) ||
      (serverWildcard && isAllowed(serverWildcard))
    ) {
      return "allow";
    }

    const detail =
      toolName === "bash"
        ? (args.command as string)
        : toolName === "write" || toolName === "edit"
          ? (args.file_path as string)
          : JSON.stringify(args);

    process.stderr.write(chalk.yellow(`\n  ⚠  ${toolName} requires confirmation\n`));
    process.stderr.write(chalk.dim(`     ${detail}\n`));

    const isMcp = toolName.startsWith("mcp__");
    const options: Array<{ key: string; label: string }> = [
      { key: "y", label: "Yes, run once" },
      { key: "p", label: "Yes, always for this project  (.opencli/settings.json)" },
      { key: "g", label: "Yes, always globally          (~/.opencli/config.json)" },
    ];
    if (isMcp) {
      options.push({ key: "t", label: `Yes, always for this tool, any args  (project)` });
      options.push({
        key: "s",
        label: `Yes, always for any tool from '${mcpMatch![1]}'  (project)`,
      });
    }
    options.push({ key: "n", label: "No, skip" });

    const choice = await selectKey(`Allow ${toolName}?`, options);

    if (choice === null || choice === "n") return "deny";

    if (choice === "p") {
      projectAllowSet.add(exactKey);
      await saveSettings({ permissions: { allow: [...projectAllowSet] } });
    } else if (choice === "g") {
      globalAllowSet.add(exactKey);
      const cfg = await loadConfig();
      await saveConfig({ permissions: { ...cfg.permissions, allow: [...globalAllowSet] } });
    } else if (choice === "t") {
      projectAllowSet.add(toolWildcard);
      await saveSettings({ permissions: { allow: [...projectAllowSet] } });
    } else if (choice === "s" && serverWildcard) {
      projectAllowSet.add(serverWildcard);
      await saveSettings({ permissions: { allow: [...projectAllowSet] } });
    }

    return "allow";
  };

  return { confirmFn, forcesConfirmation };
}
