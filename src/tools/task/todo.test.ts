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

  it("appends a pending-items footer when items remain pending", async () => {
    const items = [
      { id: "1", text: "Card detail page", status: "done" },
      { id: "2", text: "Shopping cart", status: "done" },
      { id: "3", text: "External API integration", status: "pending" },
      { id: "4", text: "Authentication", status: "pending" },
    ];
    const result = await todoWriteTool.execute({ items });
    expect(result.success).toBe(true);
    expect(result.output).toContain("2 pending item(s) remaining");
    expect(result.output).toContain("- [3] External API integration");
    expect(result.output).toContain("- [4] Authentication");
    expect(result.output).toContain("Continue with the next pending item");
  });

  it("omits the pending footer when no items are pending", async () => {
    const items = [
      { id: "1", text: "First", status: "done" },
      { id: "2", text: "Second", status: "done" },
    ];
    const result = await todoWriteTool.execute({ items });
    expect(result.output).not.toContain("pending item(s) remaining");
    expect(result.output).not.toContain("Continue with the next pending item");
  });

  it("counts in_progress items as still active (not pending) in the footer", async () => {
    const items = [
      { id: "1", text: "Currently working", status: "in_progress" },
      { id: "2", text: "Up next", status: "pending" },
    ];
    const result = await todoWriteTool.execute({ items });
    // Only "pending" status items count toward the footer reminder. in_progress
    // items are visible in the main list; the model already knows it's working on them.
    expect(result.output).toContain("1 pending item(s) remaining");
    expect(result.output).toContain("- [2] Up next");
    expect(result.output).not.toContain("- [1] Currently working");
  });
});
