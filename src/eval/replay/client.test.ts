import { describe, it, expect } from "vitest";
import { TapeClient } from "./client.js";
import type { Tape } from "./tape.js";
import type { StreamEvent } from "../../providers/types.js";

function makeTape(): Tape {
  return {
    source: "test",
    turns: [
      {
        userInput: "go",
        mode: "react",
        iterations: [
          {
            text: "",
            toolCalls: [{ name: "read", args: { file_path: "a.ts" } }],
            toolResults: [{ name: "read", result: "contents" }],
          },
          { text: "Done.", toolCalls: [], toolResults: [] },
        ],
      },
    ],
  };
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("TapeClient", () => {
  it("yields the recorded iteration's events on each stream() call", async () => {
    const c = new TapeClient(makeTape());
    const first = await collect(c.stream([], "", []));
    expect(first.map((e) => e.type)).toEqual(["function_call", "done"]);
    expect(first[0]).toMatchObject({ type: "function_call", name: "read" });

    const second = await collect(c.stream([], "", []));
    expect(second.map((e) => e.type)).toEqual(["text", "done"]);
    expect(second[0]).toMatchObject({ type: "text", text: "Done." });
  });

  it("synthesises unique ids for function_call events", async () => {
    const tape: Tape = {
      source: "x",
      turns: [
        {
          userInput: "u",
          mode: "react",
          iterations: [
            {
              text: "",
              toolCalls: [
                { name: "read", args: {} },
                { name: "read", args: {} },
              ],
              toolResults: [
                { name: "read", result: "a" },
                { name: "read", result: "b" },
              ],
            },
            { text: "ok", toolCalls: [], toolResults: [] },
          ],
        },
      ],
    };
    const c = new TapeClient(tape);
    const events = await collect(c.stream([], "", []));
    const calls = events.filter((e) => e.type === "function_call");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ id: "tape-1" });
    expect(calls[1]).toMatchObject({ id: "tape-2" });
  });

  it("records a snapshot of messages passed to each stream() call", async () => {
    const c = new TapeClient(makeTape());
    await collect(c.stream([{ role: "user", parts: [{ type: "text", text: "hi" }] }], "", []));
    await collect(c.stream([{ role: "user", parts: [{ type: "text", text: "hi2" }] }], "", []));
    expect(c.sentMessages).toHaveLength(2);
    expect(c.sentMessages[0].iterationIndex).toBe(0);
    expect(c.sentMessages[1].iterationIndex).toBe(1);
    expect(c.sentMessages[0].messages[0]).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
  });

  it("throws when the tape is exhausted", async () => {
    const c = new TapeClient(makeTape());
    await collect(c.stream([], "", []));
    await collect(c.stream([], "", []));
    expect(c.exhausted()).toBe(true);
    await expect(collect(c.stream([], "", []))).rejects.toThrow(/tape exhausted/);
  });

  it("preserves thoughtSignature on function_call events", async () => {
    const tape: Tape = {
      source: "sig",
      turns: [
        {
          userInput: "u",
          mode: "react",
          iterations: [
            {
              text: "",
              toolCalls: [{ name: "read", args: {}, thoughtSignature: "abc" }],
              toolResults: [{ name: "read", result: "x" }],
            },
            { text: "ok", toolCalls: [], toolResults: [] },
          ],
        },
      ],
    };
    const c = new TapeClient(tape);
    const events = await collect(c.stream([], "", []));
    const call = events.find((e) => e.type === "function_call");
    expect(call).toMatchObject({ thoughtSignature: "abc" });
  });
});
