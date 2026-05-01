import type { Tool } from "../base.js";

const MAX_OUTPUT = Number(process.env.OPENCLI_MAX_TOOL_OUTPUT ?? 20_000);

export const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch a URL and return its content as plain text. HTML is converted to readable text; JSON is returned as-is. Use for reading documentation, GitHub issues, API references, or any URL the user shares.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch" },
    },
    required: ["url"],
  },
  async execute({ url }) {
    try {
      const res = await fetch(url as string, {
        headers: { "User-Agent": "opencli/1.0 (https://github.com/zjshen14/opencli)" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        return { success: false, output: "", error: `HTTP ${res.status} ${res.statusText}` };
      }
      const contentType = res.headers.get("content-type") ?? "";
      const raw = await res.text();
      const text = contentType.includes("text/html") ? stripHtml(raw) : raw;
      const output = truncate(text.trim(), MAX_OUTPUT);
      return { success: true, output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: message };
    }
  },
};

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return text.slice(0, half) + "\n…[truncated]…\n" + text.slice(-half);
}
