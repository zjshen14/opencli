import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted, typed mock for dns.promises.lookup so the SSRF guard never hits the real
// network in tests. Per-test, the default resolves any host to a public address.
const { lookupMock } = vi.hoisted(() => ({
  lookupMock:
    vi.fn<
      (host: string, opts?: { all?: boolean }) => Promise<{ address: string; family: number }[]>
    >(),
}));

vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import { webFetchTool } from "./fetch.js";
import { assertSafeUrl } from "./fetch.js";

beforeEach(() => {
  vi.stubGlobal("fetch", undefined);
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function mockFetch(body: string, contentType = "text/plain", ok = true, status = 200) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      status,
      statusText: ok ? "OK" : "Not Found",
      headers: { get: () => contentType },
      body: stream,
      text: async () => body,
    }),
  );
}

describe("webFetchTool", () => {
  it("returns plain text as-is", async () => {
    mockFetch("hello world");
    const result = await webFetchTool.execute({ url: "https://example.com/text" });
    expect(result.success).toBe(true);
    expect(result.output).toBe("hello world");
  });

  it("strips HTML tags and decodes entities", async () => {
    mockFetch("<html><body><h1>Hello &amp; World</h1><p>Text</p></body></html>", "text/html");
    const result = await webFetchTool.execute({ url: "https://example.com/" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Hello & World");
    expect(result.output).not.toContain("<h1>");
  });

  it("strips script and style blocks from HTML", async () => {
    mockFetch(
      "<html><head><style>body{color:red}</style><script>alert(1)</script></head><body>Content</body></html>",
      "text/html",
    );
    const result = await webFetchTool.execute({ url: "https://example.com/" });
    expect(result.output).not.toContain("color:red");
    expect(result.output).not.toContain("alert(1)");
    expect(result.output).toContain("Content");
  });

  it("returns error on non-OK HTTP status", async () => {
    mockFetch("", "text/plain", false, 404);
    const result = await webFetchTool.execute({ url: "https://example.com/missing" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("404");
  });

  it("returns error on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await webFetchTool.execute({ url: "https://example.com/" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("network error");
  });
});

describe("webFetchTool SSRF guard (GHSA-9gqj-5w58-2j6v)", () => {
  it("refuses a non-http(s) scheme and never calls fetch", async () => {
    mockFetch("should not be reached");
    const fetchSpy = vi.mocked(fetch);
    const result = await webFetchTool.execute({ url: "file:///etc/passwd" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/scheme/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses the AWS metadata endpoint IP (169.254.169.254) and never calls fetch", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    mockFetch("should not be reached");
    const fetchSpy = vi.mocked(fetch);
    const result = await webFetchTool.execute({ url: "http://169.254.169.254/latest/meta-data/" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SSRF|private|link-local/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses localhost and 127.0.0.1", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    mockFetch("should not be reached");
    expect((await webFetchTool.execute({ url: "http://localhost:8080/admin" })).success).toBe(
      false,
    );
    expect((await webFetchTool.execute({ url: "http://127.0.0.1/x" })).success).toBe(false);
  });

  it("refuses RFC1918 private ranges", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    mockFetch("x");
    expect((await webFetchTool.execute({ url: "http://internal.corp/secret" })).success).toBe(
      false,
    );
  });

  it("refuses IPv6 loopback ::1", async () => {
    vi.mocked(lookupMock).mockResolvedValue([{ address: "::1", family: 6 }]);
    mockFetch("x");
    expect((await webFetchTool.execute({ url: "http://[::1]/" })).success).toBe(false);
  });

  it("refuses IPv6 unique-local fc00::/7 (the v6 RFC1918)", async () => {
    vi.mocked(lookupMock).mockResolvedValue([{ address: "fd00::1", family: 6 }]);
    mockFetch("x");
    expect((await webFetchTool.execute({ url: "http://ula.example/" })).success).toBe(false);
  });

  it("refuses CGNAT 100.64.0.0/10", async () => {
    vi.mocked(lookupMock).mockResolvedValue([{ address: "100.64.0.5", family: 4 }]);
    mockFetch("x");
    expect((await webFetchTool.execute({ url: "http://cgnet.example/" })).success).toBe(false);
  });

  it("refuses benchmarking 198.18.0.0/15", async () => {
    vi.mocked(lookupMock).mockResolvedValue([{ address: "198.18.0.1", family: 4 }]);
    mockFetch("x");
    expect((await webFetchTool.execute({ url: "http://bench.example/" })).success).toBe(false);
  });

  it("refuses Oracle Cloud IMDS 192.0.0.192", async () => {
    vi.mocked(lookupMock).mockResolvedValue([{ address: "192.0.0.192", family: 4 }]);
    mockFetch("x");
    expect((await webFetchTool.execute({ url: "http://oracle-imds.example/" })).success).toBe(
      false,
    );
  });

  it("refuses a redirect from a public host to a private metadata host (GHSA-9gqj)", async () => {
    // Initial host resolves public; the server 302s inward to the metadata service.
    vi.mocked(lookupMock).mockImplementation(async (host: string) =>
      host === "169.254.169.254"
        ? [{ address: "169.254.169.254", family: 4 }]
        : [{ address: "93.184.216.34", family: 4 }],
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 302,
        statusText: "Found",
        headers: {
          get: (h: string) =>
            h.toLowerCase() === "location" ? "http://169.254.169.254/latest/meta-data/" : null,
        },
        body: new ReadableStream({ start: (c: ReadableStreamDefaultController) => c.close() }),
        text: async (): Promise<string> => "",
      })),
    );
    const result = await webFetchTool.execute({ url: "https://evil.example/redir" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SSRF|private|link-local/i);
  });

  it("follows a redirect to another public host", async () => {
    vi.mocked(lookupMock).mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1) {
          return {
            ok: false,
            status: 302,
            statusText: "Found",
            headers: { get: (h: string) => (h === "location" ? "https://other.example/x" : null) },
            body: new ReadableStream({ start: (c: ReadableStreamDefaultController) => c.close() }),
            text: async (): Promise<string> => "",
          };
        }
        const enc = new TextEncoder();
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => "text/plain" },
          body: new ReadableStream({
            start: (c: ReadableStreamDefaultController) => {
              c.enqueue(enc.encode("arrived"));
              c.close();
            },
          }),
          text: async (): Promise<string> => "arrived",
        };
      }),
    );
    const result = await webFetchTool.execute({ url: "https://example.com/redir" });
    expect(result.success).toBe(true);
    expect(result.output).toBe("arrived");
  });

  it("allows a public host and calls fetch", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    mockFetch("public content");
    const fetchSpy = vi.mocked(fetch);
    const result = await webFetchTool.execute({ url: "https://example.com/" });
    expect(result.success).toBe(true);
    expect(result.output).toBe("public content");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("allows private hosts when OPENCLI_WEB_FETCH_ALLOW_PRIVATE=1", async () => {
    vi.stubEnv("OPENCLI_WEB_FETCH_ALLOW_PRIVATE", "1");
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    mockFetch("metadata");
    try {
      const result = await webFetchTool.execute({ url: "http://169.254.169.254/" });
      expect(result.success).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("aborts a response that exceeds the size cap", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const big = "x".repeat(6_000_000);
    mockFetch(big);
    const result = await webFetchTool.execute({ url: "https://example.com/big" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeded|aborted/i);
  });
});

describe("assertSafeUrl", () => {
  it("rejects an invalid URL", async () => {
    await expect(assertSafeUrl("not a url")).rejects.toThrow(/Invalid URL/);
  });
  it("rejects an ftp scheme", async () => {
    await expect(assertSafeUrl("ftp://example.com/x")).rejects.toThrow(/scheme/i);
  });
});
