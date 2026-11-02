import { describe, expect, it } from "vitest";
import type { TripDirection, TripStatus } from "@prisma/client";
import {
  isSameEpisode,
  OUTBOUND_NO_SHOW_ADVICE,
  OUTBOUND_NO_SHOW_LABEL,
  OUTBOUND_NO_SHOW_SHORT_LABEL,
  returnsToCheckAfterNoShow,
  returnTripsAfterOutboundNoShow,
  type DayLeg,
} from "./no-show";

const leg = (patientId: string, recurrenceId: string | null, facilityId: string | null) => ({ patientId, recurrenceId, facilityId });

describe("isSameEpisode", () => {
  it("pairs legs of the same recurrence, or of the same facility without one", () => {
    expect(isSameEpisode(leg("p1", "r1", "f1"), leg("p1", "r1", "f1"))).toBe(true);
    expect(isSameEpisode(leg("p1", "r1", "f1"), leg("p1", "r2", "f1"))).toBe(false);
    expect(isSameEpisode(leg("p1", null, "f1"), leg("p1", "r1", "f1"))).toBe(true);
    expect(isSameEpisode(leg("p1", null, "f1"), leg("p1", null, "f2"))).toBe(false);
    expect(isSameEpisode(leg("p1", null, null), leg("p1", null, null))).toBe(false);
    expect(isSameEpisode(leg("p1", "r1", "f1"), leg("p2", "r1", "f1"))).toBe(false);
  });
});

describe("returnTripsAfterOutboundNoShow", () => {
  it("flags the return trips whose outbound leg was a no-show", () => {
    const returns = [
      { id: "ret_a", ...leg("p1", "r1", "f1") },
      { id: "ret_b", ...leg("p2", "r2", "f1") },
      { id: "ret_c", ...leg("p3", null, "f2") },
    ];
    const noShows = [leg("p1", "r1", "f1"), leg("p3", null, "f2"), leg("p2", "r9", "f1")];
    expect(returnTripsAfterOutboundNoShow(returns, noShows)).toEqual(new Set(["ret_a", "ret_c"]));
    expect(returnTripsAfterOutboundNoShow(returns, [])).toEqual(new Set());
  });
});

describe("returnsToCheckAfterNoShow", () => {
  const trip = (
    id: string,
    direction: TripDirection,
    status: TripStatus,
    key = leg("p1", "r1", "f1"),
  ): DayLeg => ({ id, direction, status, ...key });

  it("flags the open return of an outbound leg closed as absent", () => {
    const trips = [trip("out", "OUTBOUND", "NO_SHOW"), trip("ret", "RETURN", "ASSIGNED")];
    expect(returnsToCheckAfterNoShow(trips)).toEqual(new Set(["ret"]));
    expect(returnsToCheckAfterNoShow([trip("out", "OUTBOUND", "NO_SHOW"), trip("ret", "RETURN", "PLANNED")])).toEqual(
      new Set(["ret"]),
    );
  });

  it("ignores returns already closed, started or done, and outbound legs that were not absent", () => {
    for (const status of ["CANCELLED", "NO_SHOW", "PICKED_UP", "DROPPED_OFF"] as const) {
      expect(returnsToCheckAfterNoShow([trip("out", "OUTBOUND", "NO_SHOW"), trip("ret", "RETURN", status)])).toEqual(new Set());
    }
    for (const status of ["PLANNED", "ASSIGNED", "PICKED_UP", "DROPPED_OFF", "CANCELLED"] as const) {
      expect(returnsToCheckAfterNoShow([trip("out", "OUTBOUND", status), trip("ret", "RETURN", "ASSIGNED")])).toEqual(new Set());
    }
  });

  it("pairs by patient and episode, never across patients", () => {
    const trips = [
      trip("out1", "OUTBOUND", "NO_SHOW", leg("p1", "r1", "f1")),
      trip("ret1", "RETURN", "ASSIGNED", leg("p1", "r1", "f1")),
      // Same patient, other recurrence (afternoon session): not the same episode.
      trip("ret1b", "RETURN", "ASSIGNED", leg("p1", "r2", "f1")),
      // Other patient at the same facility.
      trip("ret2", "RETURN", "ASSIGNED", leg("p2", "r1", "f1")),
      // One-off return of the same patient at the same facility.
      trip("ret1c", "RETURN", "PLANNED", leg("p1", null, "f1")),
    ];
    expect(returnsToCheckAfterNoShow(trips)).toEqual(new Set(["ret1", "ret1c"]));
  });

  it("returns nothing for a day without absence", () => {
    expect(returnsToCheckAfterNoShow([])).toEqual(new Set());
    expect(returnsToCheckAfterNoShow([trip("ret", "RETURN", "ASSIGNED")])).toEqual(new Set());
  });
});

describe("regulator texts", () => {
  it("says the absence once: the flags state it, the advice that follows them does not repeat it", () => {
    expect(OUTBOUND_NO_SHOW_LABEL.startsWith(OUTBOUND_NO_SHOW_SHORT_LABEL)).toBe(true);
    expect(OUTBOUND_NO_SHOW_SHORT_LABEL).toMatch(/absent/);
    expect(OUTBOUND_NO_SHOW_ADVICE).not.toMatch(/absent/i);
    expect(OUTBOUND_NO_SHOW_ADVICE).toMatch(/annulez le retour/);
  });
});
