import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
export const AGENT_DIR = join(homedir(), ".opencli");
const CONFIG_FILE = join(AGENT_DIR, "config.json");

export interface Permissions {
  allow?: string[];
}

export interface Config {
  geminiApiKey?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  model: string;
  temperature: number;
  maxTokens: number;
  autoExecute: boolean;
  theme: "dark" | "light";
  historySize: number;
  permissions?: Permissions;
  /** Sandbox mode for the bash tool. Absence is treated as "auto" by the CLI layer. */
  sandbox?: "auto" | "strict" | "off";
  /** Explicit provider override — takes precedence over model-name detection. */
  provider?: "gemini" | "anthropic" | "openai";
  /** Custom base URL for proxy or local inference setups (e.g. LiteLLM, Ollama). */
  baseUrl?: string;
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
    const saved = JSON.parse(raw) as Record<string, unknown>;
    // Migrate legacy apiKey → geminiApiKey
    if (typeof saved["apiKey"] === "string" && !saved["geminiApiKey"]) {
      saved["geminiApiKey"] = saved["apiKey"];
      delete saved["apiKey"];
    }
    return { ...DEFAULTS, ...(saved as Partial<Config>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveConfig(config: Partial<Config>): Promise<void> {
  const current = await loadConfig();
  const updated = { ...current, ...config };
  await mkdir(AGENT_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(updated, null, 2), "utf8");
  await chmod(CONFIG_FILE, 0o600);
}
