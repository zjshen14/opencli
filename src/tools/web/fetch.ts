import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";
import type { Tool } from "../base.js";

const MAX_OUTPUT = Number(process.env.OPENCLI_MAX_TOOL_OUTPUT ?? 20_000);

// Hard cap on bytes read from the wire, independent of the post-processing output
// truncation. Prevents a malicious endpoint from exhausting memory with a huge body.
const MAX_RESPONSE_BYTES = 5_000_000;

// Opt-out for users who legitimately need to fetch private/local endpoints (e.g. a
// local dev server). Default is deny, which is the safe choice for an agent that may
// be driven by prompt-injected content. Read at call time so tests / runtime env
// changes take effect without a re-import.
const allowPrivate = (): boolean => process.env.OPENCLI_WEB_FETCH_ALLOW_PRIVATE === "1";

// SSRF blocklist: addresses web_fetch must never reach unless explicitly allowed.
// Covers RFC1918 private ranges, loopback, link-local (incl. cloud metadata service
// 169.254.169.254), and the unspecified address, for both IPv4 and IPv6.
const SSRF_BLOCKLIST = new BlockList();
SSRF_BLOCKLIST.addSubnet("0.0.0.0", 8, "ipv4"); // unspecified
SSRF_BLOCKLIST.addSubnet("10.0.0.0", 8, "ipv4"); // private
SSRF_BLOCKLIST.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
SSRF_BLOCKLIST.addSubnet("169.254.0.0", 16, "ipv4"); // link-local (cloud IMDS)
SSRF_BLOCKLIST.addSubnet("172.16.0.0", 12, "ipv4"); // private
SSRF_BLOCKLIST.addSubnet("192.168.0.0", 16, "ipv4"); // private
SSRF_BLOCKLIST.addSubnet("::1", 128, "ipv6"); // loopback
SSRF_BLOCKLIST.addSubnet("fe80::", 10, "ipv6"); // link-local
SSRF_BLOCKLIST.addSubnet("::", 128, "ipv6"); // unspecified

function isBlockedAddress(address: string, family?: number): boolean {
  try {
    // BlockList.check auto-detection misses some IPv6 forms; pass the family
    // explicitly from dns.lookup's result.
    const type = family === 6 ? "ipv6" : "ipv4";
    return SSRF_BLOCKLIST.check(address, type);
  } catch {
    // Unparseable address — treat as blocked (defensive).
    return true;
  }
}

/**
 * Validate that a URL is safe to fetch: http(s) scheme only, and the hostname must
 * not resolve to a private/loopback/link-local address unless the caller opted in via
 * OPENCLI_WEB_FETCH_ALLOW_PRIVATE=1.
 *
 * Resolving via dns.lookup (getaddrinfo) catches literal IPs (`127.0.0.1`,
 * `169.254.169.254`), `localhost`, and hostnames whose A/AAAA records point inside
 * the machine's trusted networks. This blocks the cloud-metadata credential theft
 * and internal-service access vectors (GHSA-9gqj-5w58-2j6v).
 *
 * Limitation: a DNS-rebinding adversary could return a public address here and a
 * private one at fetch time; closing that fully requires pinning the resolved IP for
 * the fetch, which is a follow-up.
 */
export async function assertSafeUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme '${parsed.protocol}': only http and https are allowed`);
  }
  if (allowPrivate()) return;

  const host = parsed.hostname;
  let entries: { address: string; family: number }[];
  try {
    entries = await lookup(host, { all: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not resolve host '${host}': ${msg}`, { cause: err });
  }
  if (entries.length === 0) {
    throw new Error(`Could not resolve host '${host}': no addresses returned`);
  }
  for (const { address, family } of entries) {
    if (isBlockedAddress(address, family)) {
      throw new Error(
        `Refused to fetch '${rawUrl}': host '${host}' resolves to a private, loopback, or ` +
          `link-local address (${address}), which is blocked to prevent SSRF. Set ` +
          `OPENCLI_WEB_FETCH_ALLOW_PRIVATE=1 to allow.`,
      );
    }
  }
}

/** Read up to maxBytes from a Response body, aborting if the stream exceeds it. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeded ${maxBytes} bytes — aborted to prevent memory exhaustion`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

export const webFetchTool: Tool = {
  name: "web_fetch",
  readonly: true,
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
      await assertSafeUrl(url as string);
      const res = await fetch(url as string, {
        headers: { "User-Agent": "opencli/1.0 (https://github.com/zjshen14/opencli)" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        return { success: false, output: "", error: `HTTP ${res.status} ${res.statusText}` };
      }
      const contentType = res.headers.get("content-type") ?? "";
      const raw = await readCapped(res, MAX_RESPONSE_BYTES);
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
