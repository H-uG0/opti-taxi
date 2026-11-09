import { describe, expect, it } from "vitest";
import {
  historyAbsenceId,
  historyAuditEventId,
  historyDatePrefix,
  historyFuelLogId,
  historyOneOffTripId,
  historyPrescriptionId,
  historyRunId,
  historyTripId,
  historyUnavailabilityId,
  isHistoryId,
} from "./ids";

describe("history ids", () => {
  it("are deterministic, prefixed and short enough for the forms (64 characters)", () => {
    const tripId = historyTripId("2026-10-12", "cmvziuyn3001gbersi2lfwb8h", "OUTBOUND");
    expect(tripId).toBe("hist-20261012-cmvziuyn3001gbersi2lfwb8h-out");
    expect(historyTripId("2026-10-12", "cmvziuyn3001gbersi2lfwb8h", "RETURN")).toBe("hist-20261012-cmvziuyn3001gbersi2lfwb8h-ret");
    expect(tripId.length).toBeLessThanOrEqual(64);
    expect(historyRunId("2026-10-12", 2)).toBe("hist-20261012-run2");
    expect(historyAuditEventId("2026-10-12", 42)).toBe("hist-20261012-ev0042");
    expect(historyAuditEventId("2026-10-12", 12345)).toBe("hist-20261012-ev12345");
  });

  it("tell simulated rows from the others (cuid ids)", () => {
    expect(isHistoryId(historyRunId("2026-10-12", 1))).toBe(true);
    expect(isHistoryId("cmvziuyn3001gbersi2lfwb8h")).toBe(false);
    expect(isHistoryId(null)).toBe(false);
  });

  it("give the one-off trips, prescriptions, absences and vehicles off the road the date's prefix", () => {
    const prefix = historyDatePrefix("2026-10-12");
    expect(prefix).toBe("hist-20261012-");
    expect(historyOneOffTripId("2026-10-12", 7, "OUTBOUND")).toBe("hist-20261012-oneoff07-out");
    expect(historyOneOffTripId("2026-10-12", 7, "RETURN")).toBe("hist-20261012-oneoff07-ret");
    expect(historyPrescriptionId("2026-10-12", 7)).toBe("hist-20261012-rx07");
    expect(historyAbsenceId("2026-10-12", 3)).toBe("hist-20261012-abs03");
    expect(historyUnavailabilityId("2026-10-12", 1)).toBe("hist-20261012-una01");
    const fuel = historyFuelLogId("cmvziuyn3001gbersi2lfwb8h", 12);
    expect(fuel).toBe("hist-fuel-cmvziuyn3001gbersi2lfwb8h-12");
    expect(isHistoryId(fuel)).toBe(true);
    expect(fuel.length).toBeLessThanOrEqual(64);
  });
});
