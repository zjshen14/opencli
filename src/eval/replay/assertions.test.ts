import { describe, it, expect } from "vitest";
import type { ObservabilityEvent } from "../../core/observability.js";
import {
  eventsOfType,
  countOfType,
  firedBefore,
  compactStartedResolutions,
  tokenTrajectory,
  firstSnapshotAtOrAbove,
} from "./assertions.js";

function snap(messageCount: number, estimatedTokens: number): ObservabilityEvent {
  return { type: "context_snapshot", messageCount, estimatedTokens };
}

describe("eventsOfType / countOfType", () => {
  it("filters by type with narrowed return", () => {
    const stream: ObservabilityEvent[] = [
      snap(1, 100),
      snap(2, 200),
      { type: "empty_response_retry" },
    ];
    expect(eventsOfType(stream, "context_snapshot")).toHaveLength(2);
    expect(countOfType(stream, "context_snapshot")).toBe(2);
    expect(countOfType(stream, "empty_response_retry")).toBe(1);
  });
});

describe("firedBefore", () => {
  it("returns true when A appears before B", () => {
    const stream: ObservabilityEvent[] = [
      { type: "compact_threshold_warned", ratio: 0.6 },
      { type: "compact_started", trigger: "auto", ratio: 0.75 },
    ];
    expect(
      firedBefore(
        stream,
        (e) => e.type === "compact_threshold_warned",
        (e) => e.type === "compact_started",
      ),
    ).toBe(true);
  });

  it("returns false when either is missing", () => {
    const stream: ObservabilityEvent[] = [{ type: "compact_threshold_warned", ratio: 0.6 }];
    expect(
      firedBefore(
        stream,
        (e) => e.type === "compact_threshold_warned",
        (e) => e.type === "compact_started",
      ),
    ).toBe(false);
  });
});

describe("compactStartedResolutions", () => {
  it("pairs each compact_started with its following compact_completed of matching trigger", () => {
    const stream: ObservabilityEvent[] = [
      { type: "compact_started", trigger: "auto", ratio: 0.8 },
      { type: "compact_completed", trigger: "auto", messagesRemoved: 5, summaryLength: 300 },
      { type: "compact_started", trigger: "manual" },
      { type: "compact_completed", trigger: "manual", messagesRemoved: 3, summaryLength: 200 },
    ];
    const out = compactStartedResolutions(stream);
    expect(out).toHaveLength(2);
    expect(out[0].resolved?.type).toBe("compact_completed");
    expect(out[1].resolved?.type).toBe("compact_completed");
  });

  it("matches compact_failed when the summary call threw", () => {
    const stream: ObservabilityEvent[] = [
      { type: "compact_started", trigger: "auto", ratio: 0.8 },
      { type: "compact_failed", trigger: "auto", error: "timeout" },
    ];
    const out = compactStartedResolutions(stream);
    expect(out[0].resolved?.type).toBe("compact_failed");
  });

  it("reports null for an unresolved compact_started (stream truncated)", () => {
    const stream: ObservabilityEvent[] = [{ type: "compact_started", trigger: "auto", ratio: 0.8 }];
    const out = compactStartedResolutions(stream);
    expect(out[0].resolved).toBeNull();
  });
});

describe("tokenTrajectory + firstSnapshotAtOrAbove", () => {
  it("extracts a monotonic-ish token trajectory", () => {
    const stream: ObservabilityEvent[] = [snap(1, 100), snap(5, 1500), snap(10, 30000)];
    expect(tokenTrajectory(stream)).toEqual([100, 1500, 30000]);
  });

  it("finds the first index crossing a threshold", () => {
    const stream: ObservabilityEvent[] = [snap(1, 100), snap(5, 1500), snap(10, 30000)];
    expect(firstSnapshotAtOrAbove(stream, 1500)).toBe(1);
    expect(firstSnapshotAtOrAbove(stream, 1_000_000)).toBe(-1);
  });
});
