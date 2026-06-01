import { describe, it, expect } from "vitest";
import { scoreScenario } from "./scorer.js";
import type { Scenario } from "./scenarios.js";
import type { RunResult } from "./runner.js";

function makeResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    output: "",
    files: {},
    typeErrors: null,
    exitCode: 0,
    timedOut: false,
    durationMs: 1000,
    ...overrides,
  };
}

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: "test",
    category: "read-explain",
    description: "test scenario",
    prompt: "test prompt",
    fixture: "mini-ts",
    expected: {},
    ...overrides,
  };
}

describe("scoreScenario — timeout", () => {
  it("fails on timeout", () => {
    const { score } = scoreScenario(makeScenario(), makeResult({ timedOut: true }));
    expect(score).toBe("fail");
  });
});

describe("scoreScenario — non-zero exit", () => {
  it("fails on non-zero exit for code-modifying category", () => {
    const { score } = scoreScenario(
      makeScenario({ category: "bug-fix" }),
      makeResult({ exitCode: 1 }),
    );
    expect(score).toBe("fail");
  });

  it("does not fail on non-zero exit for read-explain", () => {
    const { score } = scoreScenario(
      makeScenario({ category: "read-explain", expected: { outputKeywords: ["add"] } }),
      makeResult({ exitCode: 1, output: "add subtract multiply" }),
    );
    expect(score).toBe("pass");
  });
});

describe("scoreScenario — tsc gate", () => {
  it("fails when typeErrors is non-null", () => {
    const { score } = scoreScenario(
      makeScenario({
        category: "bug-fix",
        expected: { files: { "src/math.ts": { contains: "x" } } },
      }),
      makeResult({ typeErrors: "error TS2345: argument...", files: { "src/math.ts": "x" } }),
    );
    expect(score).toBe("fail");
  });
});

describe("scoreScenario — outputKeywords", () => {
  it("passes when all keywords present", () => {
    const { score } = scoreScenario(
      makeScenario({ expected: { outputKeywords: ["add", "subtract"] } }),
      makeResult({ output: "The file exports add and subtract" }),
    );
    expect(score).toBe("pass");
  });

  it("fails when a keyword is missing", () => {
    const { score, reason } = scoreScenario(
      makeScenario({ expected: { outputKeywords: ["add", "subtract", "multiply"] } }),
      makeResult({ output: "add and subtract" }),
    );
    expect(score).toBe("fail");
    expect(reason).toContain("multiply");
  });
});

describe("scoreScenario — file checks", () => {
  it("passes when file contains expected string", () => {
    const { score } = scoreScenario(
      makeScenario({
        category: "bug-fix",
        expected: { files: { "src/x.ts": { contains: "return this._count" } } },
      }),
      makeResult({ files: { "src/x.ts": "get value() { return this._count; }" } }),
    );
    expect(score).toBe("pass");
  });

  it("fails when file is missing (null)", () => {
    const { score } = scoreScenario(
      makeScenario({
        category: "bug-fix",
        expected: { files: { "src/x.ts": { contains: "foo" } } },
      }),
      makeResult({ files: { "src/x.ts": null } }),
    );
    expect(score).toBe("fail");
  });

  it("passes array contains with AND semantics", () => {
    const { score } = scoreScenario(
      makeScenario({
        category: "feature-add",
        expected: { files: { "src/m.ts": { contains: ["typeof", "TypeError"] } } },
      }),
      makeResult({
        files: { "src/m.ts": "if (typeof x !== 'number') throw new TypeError('bad');" },
      }),
    );
    expect(score).toBe("pass");
  });

  it("fails array contains when one entry missing", () => {
    const { score } = scoreScenario(
      makeScenario({
        category: "feature-add",
        expected: { files: { "src/m.ts": { contains: ["typeof", "TypeError"] } } },
      }),
      makeResult({ files: { "src/m.ts": "if (typeof x !== 'number') throw new Error('bad');" } }),
    );
    expect(score).toBe("fail");
  });

  it("partial when half of multi-file checks pass", () => {
    const { score } = scoreScenario(
      makeScenario({
        category: "multi-file",
        expected: {
          files: {
            "src/a.ts": { contains: "foo" },
            "src/b.ts": { contains: "bar" },
          },
        },
      }),
      makeResult({ files: { "src/a.ts": "foo", "src/b.ts": "xyz" } }),
    );
    expect(score).toBe("partial");
  });

  it("fails when notContains string is present", () => {
    const { score } = scoreScenario(
      makeScenario({
        category: "bug-fix",
        expected: {
          files: { "src/x.ts": { contains: "return this._count", notContains: "this._count - 1" } },
        },
      }),
      makeResult({ files: { "src/x.ts": "return this._count - 1;" } }),
    );
    expect(score).toBe("fail");
  });

  it("passes when notContains overlaps as a substring of contains (e.g. == inside ===)", () => {
    // Regression: fix-strict-equality.yaml has contains: '=== ""' and
    // notContains: '== ""'. The correctly fixed code (s === "") contains
    // both — the scorer must strip `contains` matches before checking
    // `notContains` so this passes instead of false-failing.
    const { score } = scoreScenario(
      makeScenario({
        category: "bug-fix",
        expected: {
          files: {
            "src/utils.ts": { contains: '=== ""', notContains: '== ""' },
          },
        },
      }),
      makeResult({
        files: { "src/utils.ts": 'function f(s) { if (s === "") return s; }' },
      }),
    );
    expect(score).toBe("pass");
  });

  it("still fails when the forbidden pattern appears outside any contains match", () => {
    // Edge case for the substring-overlap fix: if the file has BOTH a correct
    // `===` AND a residual `==` somewhere else, the notContains check should
    // still fire on the residual.
    const { score } = scoreScenario(
      makeScenario({
        category: "bug-fix",
        expected: {
          files: {
            "src/utils.ts": { contains: '=== ""', notContains: '== ""' },
          },
        },
      }),
      makeResult({
        // Two functions: one fixed, one still buggy. The buggy `== ""` must
        // still trip notContains.
        files: {
          "src/utils.ts":
            'function f(s) { if (s === "") return s; }\nfunction g(s) { if (s == "") return s; }',
        },
      }),
    );
    expect(score).toBe("fail");
  });
});
