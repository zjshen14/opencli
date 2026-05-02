import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Permissions } from "./config.js";

export interface Settings {
  permissions?: Permissions;
}

export async function loadSettings(cwd = process.cwd()): Promise<Settings> {
  const file = join(cwd, ".opencli", "settings.json");
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as Settings;
  } catch {
    return {};
  }
}

export async function saveSettings(patch: Partial<Settings>, cwd = process.cwd()): Promise<void> {
  const dir = join(cwd, ".opencli");
  const file = join(dir, "settings.json");
  const current = await loadSettings(cwd);
  const updated: Settings = {
    ...current,
    ...patch,
    permissions:
      patch.permissions !== undefined
        ? { ...current.permissions, ...patch.permissions }
        : current.permissions,
  };
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(updated, null, 2), "utf8");
}
