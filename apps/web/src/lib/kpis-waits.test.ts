import { describe, expect, it } from "vitest";
import { quantile, type KpiTrip } from "./kpis-rows";
import { addWaits, emptyWaits, rideTime, waitAfterSession, waitBeforeAppointment, waitsOfDay } from "./kpis-waits";

// November 2026: Europe/Paris is UTC+1.
const DAY = "2026-11-03";
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+01:00`);
const OPTIONS = { maxTotalWaitMin: 45, maxRideExtraMin: 30 };

function outbound(overrides: Partial<KpiTrip> = {}): KpiTrip {
  return {
    id: "out",
    patientId: "p1",
    recurrenceId: "rec1",
    facilityId: "f1",
    serviceDate: DAY,
    status: "DROPPED_OFF",
    routeId: "r1",
    direction: "OUTBOUND",
    shared: false,
    appointmentMinute: 480,
    plannedDropoffMinute: 455,
    pickupCompletedAt: at("07:20"),
    dropoffCompletedAt: at("07:40"),
    ...overrides,
  };
}

function back(overrides: Partial<KpiTrip> = {}): KpiTrip {
  return outbound({
    id: "back",
    direction: "RETURN",
    appointmentMinute: null,
    readyMinute: 720,
    plannedDropoffMinute: 760,
    pickupServiceMinutes: 5,
    pickupCompletedAt: at("12:15"),
    dropoffCompletedAt: at("12:45"),
    ...overrides,
  });
}

describe("waits and time on board (KPI-05)", () => {
  it("measures the wait before the appointment and after the session from the crews' taps", () => {
    expect(waitBeforeAppointment(outbound())).toBe(20);
    // Dropped off late: no wait (the lateness is counted elsewhere).
    expect(waitBeforeAppointment(outbound({ dropoffCompletedAt: at("08:10") }))).toBe(0);
    // Picked up at 12:15 with 5 minutes of boarding, session over at 12:00: 10 minutes.
    expect(waitAfterSession(back())).toBe(10);
    expect(waitAfterSession(back({ pickupCompletedAt: at("11:58") }))).toBe(0);
    expect(waitAfterSession(back({ status: "PICKED_UP" }))).toBe(10);
    // Not measured: no time, or the trip not carried.
    expect(waitBeforeAppointment(outbound({ dropoffCompletedAt: null }))).toBeNull();
    expect(waitAfterSession(back({ pickupCompletedAt: null }))).toBeNull();
    expect(waitAfterSession(back({ status: "NO_SHOW" }))).toBeNull();
  });

  it("adds the legs of a care session and lists the shared ones over the limit", () => {
    const totals = waitsOfDay(
      [
        outbound({ shared: true, dropoffCompletedAt: at("07:30") }),
        back({ pickupCompletedAt: at("12:20") }),
        // Another patient, not shared, 50 minutes: over the limit but not listed.
        outbound({ id: "o2", patientId: "p2", recurrenceId: "rec2", dropoffCompletedAt: at("07:30") }),
        back({ id: "b2", patientId: "p2", recurrenceId: "rec2", pickupCompletedAt: at("12:25") }),
        // A session whose return was not recorded: not measured.
        outbound({ id: "o3", patientId: "p3", recurrenceId: "rec3" }),
        back({ id: "b3", patientId: "p3", recurrenceId: "rec3", status: "ASSIGNED", pickupCompletedAt: null, dropoffCompletedAt: null }),
        // An outbound alone (the patient goes back by their own means).
        outbound({ id: "o4", patientId: "p4", recurrenceId: null, facilityId: "f9", shared: true }),
      ],
      OPTIONS,
    );
    expect(totals.sessions).toBe(3);
    expect(totals.totalWaits).toEqual([45, 50, 20]);
    expect(totals.overMax).toBe(1);
    expect(totals.sharedSessions).toBe(2);
    // 30 + 15 = 45: at the limit, not over it.
    expect(totals.sharedOverMax).toBe(0);
    const over = waitsOfDay([outbound({ shared: true, dropoffCompletedAt: at("07:25") }), back({ pickupCompletedAt: at("12:20") })], OPTIONS);
    expect(over.cases).toEqual([
      { serviceDate: DAY, patientId: "p1", outboundTripId: "out", returnTripId: "back", beforeMin: 35, afterMin: 15, totalMin: 50 },
    ]);
    expect(totals.afterWaits).toEqual([15, 20]);
    expect(quantile(totals.afterWaits, 0.5)).toBe(17.5);
  });

  it("compares the time on board with the direct drive estimated from the plan", () => {
    // 30 minutes on board, planned 24 for 12 km direct + 4 km of detour: direct about 18 minutes.
    const ride = rideTime(outbound({ pickupCompletedAt: at("07:00"), dropoffCompletedAt: at("07:30"), plannedRideMinutes: 24, directKm: 12, detourKm: 4 }));
    expect(ride?.onBoard).toBe(30);
    expect(ride?.excess).toBeCloseTo(12);
    expect(rideTime(outbound({ plannedRideMinutes: 10 }))).toEqual({ onBoard: 20, excess: 10 });
    expect(rideTime(outbound({ plannedRideMinutes: null }))).toEqual({ onBoard: 20, excess: null });
    expect(rideTime(outbound({ status: "PICKED_UP" }))).toBeNull();
    const totals = waitsOfDay([outbound({ plannedRideMinutes: 10, dropoffCompletedAt: at("08:05") })], OPTIONS);
    expect(totals.rideExcess).toEqual([35]);
    expect(totals.rideOverMax).toBe(1);
  });

  it("adds two periods", () => {
    const a = waitsOfDay([outbound({ shared: true, dropoffCompletedAt: at("07:00") })], OPTIONS);
    const sum = addWaits(a, a);
    expect(sum.sharedOverMax).toBe(2);
    expect(sum.cases).toHaveLength(2);
    expect(addWaits(emptyWaits(), emptyWaits())).toEqual(emptyWaits());
  });
});
