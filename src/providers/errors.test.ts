import { describe, it, expect } from "vitest";
import { toFriendlyError } from "./errors.js";

function makeStatusError(status: number, message = "raw sdk error"): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

describe("toFriendlyError", () => {
  it("maps 401 to invalid key message for Gemini", () => {
    const err = toFriendlyError(makeStatusError(401), "Gemini");
    expect(err.message).toContain("Invalid Gemini API key");
    expect(err.message).toContain("--gemini-api-key");
  });

  it("maps 401 to invalid key message for Anthropic", () => {
    const err = toFriendlyError(makeStatusError(401), "Anthropic");
    expect(err.message).toContain("Invalid Anthropic API key");
    expect(err.message).toContain("--anthropic-api-key");
  });

  it("maps 401 to invalid key message for OpenAI", () => {
    const err = toFriendlyError(makeStatusError(401), "OpenAI");
    expect(err.message).toContain("Invalid OpenAI API key");
    expect(err.message).toContain("--openai-api-key");
  });

  it("maps 429 to rate limit message", () => {
    const err = toFriendlyError(makeStatusError(429), "Gemini");
    expect(err.message).toContain("rate limit");
    expect(err.message).toContain("Gemini");
  });

  it("maps 400 to bad request message including original detail", () => {
    const err = toFriendlyError(makeStatusError(400, "quota exceeded"), "Anthropic");
    expect(err.message).toContain("bad request (400)");
    expect(err.message).toContain("Anthropic");
    expect(err.message).toContain("quota exceeded");
  });

  it("maps 404 to model not found message", () => {
    const err = toFriendlyError(makeStatusError(404, "model not found"), "Gemini");
    expect(err.message).toContain("model not found (404)");
    expect(err.message).toContain("--model");
  });

  it("unwraps Gemini double-nested JSON in 400 message", () => {
    const inner = JSON.stringify({
      error: {
        code: 400,
        message: "API key expired. Please renew the API key.",
        status: "INVALID_ARGUMENT",
      },
    });
    const outer = JSON.stringify({ error: { message: inner, code: 400, status: "Bad Request" } });
    const err = toFriendlyError(makeStatusError(400, outer), "Gemini");
    expect(err.message).toContain("API key expired");
    expect(err.message).not.toContain("{");
  });

  it("maps 403 to access denied message", () => {
    const err = toFriendlyError(makeStatusError(403), "OpenAI");
    expect(err.message).toContain("access denied (403)");
  });

  it("maps 500 to server error message", () => {
    const err = toFriendlyError(makeStatusError(500), "Gemini");
    expect(err.message).toContain("server error (500)");
    expect(err.message).toContain("Gemini");
  });

  it("maps 503 to server error message", () => {
    const err = toFriendlyError(makeStatusError(503), "Anthropic");
    expect(err.message).toContain("server error (503)");
  });

  it("falls back to original message when no status", () => {
    const original = new Error("network timeout");
    const err = toFriendlyError(original, "OpenAI");
    expect(err.message).toContain("network timeout");
    expect(err.message).toContain("OpenAI");
  });

  it("sets .cause to the original error", () => {
    const original = makeStatusError(401, "raw response body");
    const err = toFriendlyError(original, "Gemini");
    expect(err.cause).toBe(original);
  });

  it("wraps non-Error values in an Error", () => {
    const err = toFriendlyError("some string error", "Gemini");
    expect(err).toBeInstanceOf(Error);
    expect(err.cause).toBeInstanceOf(Error);
  });
});
