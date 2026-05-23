import { describe, it, expect } from "vitest";
import { InvalidArgumentError } from "commander";
import { parseTransport } from "./mcp-cmd.js";

describe("parseTransport", () => {
  it("accepts 'stdio'", () => {
    expect(parseTransport("stdio")).toBe("stdio");
  });

  it("accepts 'http'", () => {
    expect(parseTransport("http")).toBe("http");
  });

  it("throws InvalidArgumentError for an unrecognised value", () => {
    expect(() => parseTransport("invalidtype")).toThrow(InvalidArgumentError);
  });

  it("throws InvalidArgumentError for an empty string", () => {
    expect(() => parseTransport("")).toThrow(InvalidArgumentError);
  });

  it("error message names the flag", () => {
    let caught: Error | undefined;
    try {
      parseTransport("websocket");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toContain("--transport");
  });
});
