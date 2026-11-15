import { describe, expect, it } from "vitest";
import { dayClosing, entryRateText, type ClosingTrip } from "./day-closing";

const trip = (id: string, status: ClosingTrip["status"], routeId: string | null, minute = 480): ClosingTrip => ({
  id,
  status,
  routeId,
  direction: "OUTBOUND",
  patientName: `Patient ${id}`,
  plannedPickupMinute: minute,
});

describe("dayClosing (FLD-02)", () => {
  const routes = [
    { id: "r1", vehicleLabel: "Taxi 2", people: [{ id: "d1", name: "MARTIN J." }] },
    { id: "r2", vehicleLabel: "Ambulance 1", people: [{ id: "d2", name: "AUBERT L." }, { id: "d3", name: "BLANC P." }] },
  ];

  it("counts the outcomes recorded (dropped off or absent) over the trips placed, per day and per person", () => {
    const closing = dayClosing("2026-11-15", routes, [
      trip("a", "DROPPED_OFF", "r1"),
      trip("b", "NO_SHOW", "r1"),
      trip("c", "PICKED_UP", "r1", 600),
      trip("d", "ASSIGNED", "r2", 420),
      trip("e", "DROPPED_OFF", "r2"),
      // Cancelled, or not on a route: not counted.
      trip("x", "CANCELLED", "r1"),
      trip("y", "PLANNED", null),
    ]);
    expect(closing).toMatchObject({ placed: 5, recorded: 3 });
    expect(closing.people).toEqual([
      { id: "d2", name: "AUBERT L.", placed: 2, recorded: 1 },
      { id: "d3", name: "BLANC P.", placed: 2, recorded: 1 },
      { id: "d1", name: "MARTIN J.", placed: 3, recorded: 2 },
    ]);
    expect(closing.unclosed).toEqual([
      { tripId: "d", vehicleLabel: "Ambulance 1", patientName: "Patient d", direction: "OUTBOUND", plannedPickupMinute: 420, onBoard: false },
      { tripId: "c", vehicleLabel: "Taxi 2", patientName: "Patient c", direction: "OUTBOUND", plannedPickupMinute: 600, onBoard: true },
    ]);
  });

  it("closes a trip the regulation corrected, without counting it as the crew's entry", () => {
    const closing = dayClosing("2026-11-15", routes, [trip("a", "DROPPED_OFF", "r1"), { ...trip("b", "DROPPED_OFF", "r1"), outcomeCorrected: true }]);
    expect(closing).toMatchObject({ placed: 2, recorded: 1, unclosed: [] });
    expect(closing.people).toEqual([{ id: "d1", name: "MARTIN J.", placed: 2, recorded: 1 }]);
  });

  it("writes a rate without rounding up to 100 %", () => {
    expect(entryRateText({ placed: 200, recorded: 199 })).toBe("99 %");
    expect(entryRateText({ placed: 3, recorded: 3 })).toBe("100 %");
    expect(entryRateText({ placed: 0, recorded: 0 })).toBe("—");
  });
});
