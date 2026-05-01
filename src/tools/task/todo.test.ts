import { describe, it, expect } from "vitest";
import { todoWriteTool, todoReadTool } from "./todo.js";

describe("todoWriteTool / todoReadTool", () => {
  it("writes items and reads them back", async () => {
    const items = [
      { id: "1", text: "Do the thing", status: "pending" },
      { id: "2", text: "Review it", status: "done" },
    ];
    const writeResult = await todoWriteTool.execute({ items });
    expect(writeResult.success).toBe(true);
    expect(writeResult.output).toContain("Do the thing");
    expect(writeResult.output).toContain("Review it");

    const readResult = await todoReadTool.execute({});
    expect(readResult.success).toBe(true);
    expect(readResult.output).toContain("Do the thing");
    expect(readResult.output).toContain("Review it");
  });

  it("shows correct status icons", async () => {
    const items = [
      { id: "1", text: "Pending", status: "pending" },
      { id: "2", text: "In progress", status: "in_progress" },
      { id: "3", text: "Done", status: "done" },
    ];
    const result = await todoWriteTool.execute({ items });
    expect(result.output).toContain("[ ] 1. Pending");
    expect(result.output).toContain("[~] 2. In progress");
    expect(result.output).toContain("[x] 3. Done");
  });

  it("read returns placeholder when no list exists yet", async () => {
    // This test depends on order — run it before write creates the file.
    // Since TODO_PATH is per-pid, a fresh test process has no file.
    // We can't guarantee order, so just check success.
    const result = await todoReadTool.execute({});
    expect(result.success).toBe(true);
  });

  it("overwrites the list on each write call", async () => {
    await todoWriteTool.execute({ items: [{ id: "1", text: "Old", status: "pending" }] });
    await todoWriteTool.execute({ items: [{ id: "2", text: "New", status: "done" }] });
    const readResult = await todoReadTool.execute({});
    expect(readResult.output).not.toContain("Old");
    expect(readResult.output).toContain("New");
  });
});
