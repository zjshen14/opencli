import chalk from "chalk";
import type { ConfirmFn } from "../core/executor.js";
import { loadConfig, saveConfig } from "../state/config.js";
import { loadSettings, saveSettings } from "../state/settings.js";
import { selectKey } from "./input.js";

export async function createConfirmFn(): Promise<ConfirmFn> {
  const [config, settings] = await Promise.all([loadConfig(), loadSettings()]);

  const globalAllowSet = new Set<string>(config.permissions?.allow ?? []);
  const projectAllowSet = new Set<string>(settings.permissions?.allow ?? []);

  return async (toolName, args) => {
    if (!process.stdin.isTTY) return "deny";

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
}
