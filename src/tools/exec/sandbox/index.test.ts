import { describe, it, expect } from "vitest";
import { createSandboxRunner, PassthroughRunner, SandboxExecRunner, BwrapRunner } from "./index.js";

describe("createSandboxRunner", () => {
  it('returns PassthroughRunner for mode "off"', () => {
    const runner = createSandboxRunner("off", process.cwd());
    expect(runner).toBeInstanceOf(PassthroughRunner);
    expect(runner.mode).toBe("off");
  });

  it(
    'returns SandboxExecRunner on macOS for mode "auto"',
    { skip: process.platform !== "darwin" },
    () => {
      const runner = createSandboxRunner("auto", process.cwd());
      expect(runner).toBeInstanceOf(SandboxExecRunner);
    },
  );

  it('returns BwrapRunner on Linux for mode "auto"', { skip: process.platform !== "linux" }, () => {
    const runner = createSandboxRunner("auto", process.cwd());
    expect(runner).toBeInstanceOf(BwrapRunner);
  });

  it("returns PassthroughRunner with warning on unsupported platform", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const runner = createSandboxRunner("auto", process.cwd());
      expect(runner).toBeInstanceOf(PassthroughRunner);
      expect(runner.warning).toMatch(/not supported/);
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });
});
