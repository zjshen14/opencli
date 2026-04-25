import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const AGENT_DIR = join(homedir(), ".opencli");
const CONFIG_FILE = join(AGENT_DIR, "config.json");

export interface Config {
  apiKey?: string;
  model: string;
  temperature: number;
  maxTokens: number;
  autoExecute: boolean;
  theme: "dark" | "light";
  historySize: number;
}

const DEFAULTS: Config = {
  model: "gemini-3.1-flash-lite-preview",
  temperature: 0.7,
  maxTokens: 8192,
  autoExecute: false,
  theme: "dark",
  historySize: 50,
};

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await readFile(CONFIG_FILE, "utf8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveConfig(config: Partial<Config>): Promise<void> {
  const current = await loadConfig();
  const updated = { ...current, ...config };
  await mkdir(AGENT_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(updated, null, 2), "utf8");
}

export function resolveApiKey(config: Config): string {
  const key = process.env.GEMINI_API_KEY ?? config.apiKey;
  if (!key) {
    throw new Error(
      "No API key found. Set GEMINI_API_KEY environment variable or run: opencli config --api-key <key>",
    );
  }
  return key;
}
