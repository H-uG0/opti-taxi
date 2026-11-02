import { describe, expect, it } from "vitest";
import { historyRunId, historyTripId, isHistoryId } from "./ids";

describe("history ids", () => {
  it("are deterministic, prefixed and short enough for the forms (64 characters)", () => {
    const tripId = historyTripId("2026-10-12", "cmvziuyn3001gbersi2lfwb8h", "OUTBOUND");
    expect(tripId).toBe("hist-20261012-cmvziuyn3001gbersi2lfwb8h-out");
    expect(historyTripId("2026-10-12", "cmvziuyn3001gbersi2lfwb8h", "RETURN")).toBe("hist-20261012-cmvziuyn3001gbersi2lfwb8h-ret");
    expect(tripId.length).toBeLessThanOrEqual(64);
    expect(historyRunId("2026-10-12", 2)).toBe("hist-20261012-run2");
  });

  it("tell simulated rows from the others (cuid ids)", () => {
    expect(isHistoryId(historyRunId("2026-10-12", 1))).toBe(true);
    expect(isHistoryId("cmvziuyn3001gbersi2lfwb8h")).toBe(false);
    expect(isHistoryId(null)).toBe(false);
  });
});
