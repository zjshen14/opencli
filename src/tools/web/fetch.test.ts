import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { webFetchTool } from "./fetch.js";

beforeEach(() => {
  vi.stubGlobal("fetch", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(body: string, contentType = "text/plain", ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      status,
      statusText: ok ? "OK" : "Not Found",
      headers: { get: () => contentType },
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
