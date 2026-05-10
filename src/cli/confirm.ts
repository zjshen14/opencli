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

    const key = `${toolName}:${JSON.stringify(args)}`;
    if (globalAllowSet.has(key) || projectAllowSet.has(key)) return "allow";

    const detail =
      toolName === "bash"
        ? (args.command as string)
        : toolName === "write" || toolName === "edit"
          ? (args.file_path as string)
          : JSON.stringify(args);

    process.stderr.write(chalk.yellow(`\n  ⚠  ${toolName} requires confirmation\n`));
    process.stderr.write(chalk.dim(`     ${detail}\n`));

    const choice = await selectKey(`Allow ${toolName}?`, [
      { key: "y", label: "Yes, run once" },
      { key: "p", label: "Yes, always for this project  (.opencli/settings.json)" },
      { key: "g", label: "Yes, always globally          (~/.opencli/config.json)" },
      { key: "n", label: "No, skip" },
    ]);

    if (choice === null || choice === "n") return "deny";

    if (choice === "p") {
      projectAllowSet.add(key);
      await saveSettings({ permissions: { allow: [...projectAllowSet] } });
    } else if (choice === "g") {
      globalAllowSet.add(key);
      const cfg = await loadConfig();
      await saveConfig({ permissions: { ...cfg.permissions, allow: [...globalAllowSet] } });
    }

    return "allow";
  };
}
