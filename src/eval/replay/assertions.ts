/**
 * Assertion helpers over the ObservabilityEvent stream captured by
 * runTape(). Each helper returns either a matching event (or events) for
 * further inspection, or a descriptive error string the caller can pass to
 * vitest's `expect().fail()` or convert to a thrown assertion.
 *
 * Kept dependency-free so it can be used from any test file (we may want
 * to invoke these from D1 scenarios down the line — same assertion
 * vocabulary, different input source).
 */
import type { ObservabilityEvent } from "../../core/observability.js";

type EventOfType<T extends ObservabilityEvent["type"]> = Extract<ObservabilityEvent, { type: T }>;

export function eventsOfType<T extends ObservabilityEvent["type"]>(
  stream: ObservabilityEvent[],
  type: T,
): EventOfType<T>[] {
  return stream.filter((e): e is EventOfType<T> => e.type === type);
}

export function countOfType(
  stream: ObservabilityEvent[],
  type: ObservabilityEvent["type"],
): number {
  return eventsOfType(stream, type).length;
}

/**
 * Index of the FIRST event matching the predicate, or -1. Useful for
 * "fired before / after" ordering assertions.
 */
export function indexOfFirst(
  stream: ObservabilityEvent[],
  pred: (e: ObservabilityEvent) => boolean,
): number {
  return stream.findIndex(pred);
}

/** Did event A fire before event B in the stream? Returns false if either
 *  is missing. */
export function firedBefore(
  stream: ObservabilityEvent[],
  a: (e: ObservabilityEvent) => boolean,
  b: (e: ObservabilityEvent) => boolean,
): boolean {
  const ia = indexOfFirst(stream, a);
  const ib = indexOfFirst(stream, b);
  return ia !== -1 && ib !== -1 && ia < ib;
}

/**
 * Every `compact_started` is followed somewhere later by a matching
 * `compact_completed` or `compact_failed`. Returns a list of started
 * events with their resolution (or null if the stream truncated before
 * resolution).
 */
export function compactStartedResolutions(stream: ObservabilityEvent[]): {
  started: EventOfType<"compact_started">;
  resolved: EventOfType<"compact_completed"> | EventOfType<"compact_failed"> | null;
}[] {
  const out: ReturnType<typeof compactStartedResolutions> = [];
  let pendingTrigger: "auto" | "manual" | null = null;
  let pendingStartIdx = -1;
  let pendingStart: EventOfType<"compact_started"> | null = null;

  for (let i = 0; i < stream.length; i++) {
    const e = stream[i];
    if (e.type === "compact_started") {
      // If a previous start was never resolved, push it with null first.
      if (pendingStart) out.push({ started: pendingStart, resolved: null });
      pendingStart = e;
      pendingTrigger = e.trigger;
      pendingStartIdx = i;
      continue;
    }
    if (
      pendingStart &&
      (e.type === "compact_completed" || e.type === "compact_failed") &&
      e.trigger === pendingTrigger
    ) {
      out.push({ started: pendingStart, resolved: e });
      pendingStart = null;
      pendingTrigger = null;
      pendingStartIdx = -1;
    }
  }
  if (pendingStart) out.push({ started: pendingStart, resolved: null });
  void pendingStartIdx; // silence unused
  return out;
}

/** Sorted ascending estimated-token values from context_snapshot events.
 *  Useful for asserting the token trajectory crossed a threshold. */
export function tokenTrajectory(stream: ObservabilityEvent[]): number[] {
  return eventsOfType(stream, "context_snapshot").map((e) => e.estimatedTokens);
}

/** Index of the first context_snapshot at or above `tokens`, or -1. */
export function firstSnapshotAtOrAbove(stream: ObservabilityEvent[], tokens: number): number {
  return stream.findIndex((e) => e.type === "context_snapshot" && e.estimatedTokens >= tokens);
}
