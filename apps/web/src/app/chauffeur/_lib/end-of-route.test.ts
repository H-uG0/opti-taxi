import { describe, expect, it } from "vitest";
import { endOfRouteView, forgottenStops, type EndOfRouteStopInput } from "./end-of-route";

const stop = (id: string, sequence: number, kind: "PICKUP" | "DROPOFF", tripId: string, status: EndOfRouteStopInput["trip"]["status"], done = false): EndOfRouteStopInput => ({
  id,
  sequence,
  kind,
  tripId,
  startMinute: 420 + sequence * 20,
  address: `${sequence} rue du Test, 04100 Manosque`,
  completedAt: done ? new Date("2026-11-15T07:00:00.000Z") : null,
  trip: { status, direction: "OUTBOUND", patient: { firstName: "Jeanne", lastName: `Martin${tripId}` } },
});

describe("endOfRouteView (FLD-02)", () => {
  it("lists the stops left without a status, the patient and the town only, and counts the statuses entered", () => {
    const view = endOfRouteView([
      stop("s1", 1, "PICKUP", "a", "DROPPED_OFF", true),
      stop("s2", 2, "DROPOFF", "a", "DROPPED_OFF", true),
      stop("s3", 3, "PICKUP", "b", "ASSIGNED"),
      stop("s4", 4, "DROPOFF", "b", "ASSIGNED"),
      // Absent: the pickup is closed and the drop-off skipped.
      stop("s5", 5, "PICKUP", "c", "NO_SHOW", true),
      stop("s6", 6, "DROPOFF", "c", "NO_SHOW"),
      // On board, drop-off forgotten.
      stop("s7", 7, "PICKUP", "d", "PICKED_UP", true),
      stop("s8", 8, "DROPOFF", "d", "PICKED_UP"),
    ]);
    expect(view).toMatchObject({ closed: 5, total: 8 });
    expect(view.pending).toEqual([
      { id: "s3", kind: "PICKUP", plannedMinute: 480, patient: "Jeanne MARTINB", town: "Manosque", pickupStopId: null },
      { id: "s4", kind: "DROPOFF", plannedMinute: 500, patient: "Jeanne MARTINB", town: "Manosque", pickupStopId: "s3" },
      { id: "s8", kind: "DROPOFF", plannedMinute: 580, patient: "Jeanne MARTIND", town: "Manosque", pickupStopId: null },
    ]);
  });

  it("counts as forgotten the stops whose time is past by more than 10 min, all of them on a past day", () => {
    const pending = [{ plannedMinute: 480 }, { plannedMinute: 600 }];
    expect(forgottenStops(pending, 495)).toBe(1);
    expect(forgottenStops(pending, 480)).toBe(0);
    expect(forgottenStops(pending, null)).toBe(2);
  });
});
