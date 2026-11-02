import { beforeAll, describe, expect, it } from "vitest";
import {
  CANCEL,
  decodeSync,
  describeSync,
  encodeSync,
  nextSharingStatus,
  planTripChange,
  prescriptionTarget,
  recurrenceSchedules,
  recurrenceTarget,
  renewalTarget,
  withSyncNotice,
  type DateRange,
  type PrescriptionRules,
  type RecurrenceSchedule,
  type SyncTrip,
} from "./trip-sync";

// The first Date/Intl call of a process initialises ICU time zones, which takes
// several seconds on slow machines: pay it once here, outside the test timeouts.
beforeAll(() => {
  new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC" }).format(new Date("2026-01-01T00:00:00.000Z"));
}, 60_000);

const TODAY = "2026-11-02"; // a Monday
const TOMORROW = "2026-11-03";

const HOME = { address: "4 avenue Jean Jaurès, 04100 Manosque", lat: 43.8297, lng: 5.7864 };
const CLINIC = { address: "1 rue de l'Hôpital, 13001 Marseille", lat: 43.3, lng: 5.38 };

function trip(overrides: Partial<SyncTrip> = {}): SyncTrip {
  return {
    id: "t1",
    serviceDate: TOMORROW,
    direction: "OUTBOUND",
    status: "PLANNED",
    payer: "CPAM",
    prescriptionId: "p1",
    facilityId: "f1",
    allowedVehicleTypes: ["TAXI", "VSL"],
    sharingAllowed: true,
    sharingStatus: "NOT_PROPOSED",
    shared: false,
    appointmentMinute: 450,
    readyMinute: null,
    pickupAddress: HOME.address,
    pickupLat: HOME.lat,
    pickupLng: HOME.lng,
    dropoffAddress: CLINIC.address,
    dropoffLat: CLINIC.lat,
    dropoffLng: CLINIC.lng,
    routeId: null,
    routeVehicleType: null,
    lockedVehicleId: null,
    lockedVehicleType: null,
    prescriptionValidity: { validFrom: "2026-09-01", validTo: "2027-02-28" },
    ...overrides,
  };
}

const TAP_BOTH = { id: "p1", mode: "TAP" as const, sharing: "BOTH" as const, validFrom: "2026-09-01", validTo: "2027-02-28" };

describe("planTripChange", () => {
  it("leaves past, started and cancelled trips alone", () => {
    expect(planTripChange(trip({ serviceDate: "2026-11-01" }), CANCEL, TODAY)).toEqual({ type: "none" });
    for (const status of ["PICKED_UP", "DROPPED_OFF", "CANCELLED", "NO_SHOW"] as const) {
      expect(planTripChange(trip({ status }), CANCEL, TODAY)).toEqual({ type: "none" });
    }
  });

  it("cancels a trip, takes it out of its route and drops its lock", () => {
    const decision = planTripChange(trip({ status: "ASSIGNED", routeId: "r1", routeVehicleType: "TAXI", lockedVehicleId: "v1" }), CANCEL, TODAY);
    expect(decision).toEqual({
      type: "change",
      change: {
        tripId: "t1",
        expectedStatus: "ASSIGNED",
        cancel: true,
        detach: true,
        data: {
          status: "CANCELLED",
          routeId: null,
          plannedPickupMinute: null,
          plannedDropoffMinute: null,
          shared: false,
          detourKm: null,
          estimatedRevenue: null,
          lockedVehicleId: null,
        },
      },
    });
  });

  it("does not touch a trip of today already in a route (the day is under way)", () => {
    expect(planTripChange(trip({ serviceDate: TODAY, routeId: "r1", status: "ASSIGNED" }), CANCEL, TODAY)).toEqual({
      type: "deferred",
    });
    // An unplanned trip of today can still be cancelled.
    const free = planTripChange(trip({ serviceDate: TODAY }), CANCEL, TODAY);
    expect(free.type === "change" && free.change.detach).toBe(false);
  });

  it("does nothing when the trip already matches", () => {
    expect(planTripChange(trip(), { kind: "update", prescription: TAP_BOTH, home: HOME, keyMinute: 450 }, TODAY)).toEqual({
      type: "none",
    });
  });

  it("switches a TAP trip to ambulance: allowed types, sharing, lock and route follow", () => {
    const decision = planTripChange(
      trip({
        status: "ASSIGNED",
        routeId: "r1",
        routeVehicleType: "TAXI",
        lockedVehicleId: "taxi-1",
        lockedVehicleType: "TAXI",
        shared: true,
        sharingStatus: "PROPOSED",
      }),
      { kind: "update", prescription: { id: "p1", mode: "AMBULANCE", sharing: "NONE" } },
      TODAY,
    );
    expect(decision.type).toBe("change");
    if (decision.type !== "change") return;
    expect(decision.change.detach).toBe(true);
    expect(decision.change.data).toMatchObject({
      allowedVehicleTypes: ["AMBULANCE"],
      sharingAllowed: false,
      sharingStatus: "NOT_ELIGIBLE",
      lockedVehicleId: null,
      routeId: null,
      shared: false,
      status: "PLANNED",
    });
  });

  it("keeps a recorded refusal when sharing is withdrawn, and the route when it still holds", () => {
    const decision = planTripChange(
      trip({ routeId: "r1", routeVehicleType: "VSL", status: "ASSIGNED", sharingStatus: "REFUSED" }),
      { kind: "update", prescription: { id: "p1", mode: "TAP", sharing: "NONE" } },
      TODAY,
    );
    expect(decision).toEqual({
      type: "change",
      change: { tripId: "t1", expectedStatus: "ASSIGNED", cancel: false, detach: false, data: { sharingAllowed: false } },
    });
  });

  it("detaches a shared trip whose sharing is withdrawn", () => {
    const decision = planTripChange(
      trip({ routeId: "r1", routeVehicleType: "TAXI", status: "ASSIGNED", shared: true, sharingStatus: "ACCEPTED" }),
      { kind: "update", prescription: { id: "p1", mode: "TAP", sharing: "RETURN" } },
      TODAY,
    );
    expect(decision.type === "change" && decision.change.detach).toBe(true);
    expect(decision.type === "change" && decision.change.data.sharingStatus).toBe("NOT_ELIGIBLE");
  });

  it("makes a trip eligible again when sharing is allowed", () => {
    const decision = planTripChange(
      trip({ sharingAllowed: false, sharingStatus: "NOT_ELIGIBLE" }),
      { kind: "update", prescription: TAP_BOTH },
      TODAY,
    );
    expect(decision.type === "change" && decision.change.data).toEqual({ sharingAllowed: true, sharingStatus: "NOT_PROPOSED" });
  });

  it("copies a new home address on the right side and leaves the route", () => {
    const moved = { address: "8 rue Neuve, 04200 Sisteron", lat: 44.19, lng: 5.94 };
    const outbound = planTripChange(trip({ routeId: "r1", routeVehicleType: "TAXI", status: "ASSIGNED" }), { kind: "update", home: moved }, TODAY);
    expect(outbound.type === "change" && outbound.change.data).toMatchObject({
      pickupAddress: moved.address,
      pickupLat: moved.lat,
      pickupLng: moved.lng,
      routeId: null,
      status: "PLANNED",
    });
    const back = planTripChange(
      trip({ direction: "RETURN", appointmentMinute: null, readyMinute: 690, pickupAddress: CLINIC.address, dropoffAddress: HOME.address }),
      { kind: "update", home: moved },
      TODAY,
    );
    expect(back.type === "change" && back.change.data).toEqual({
      dropoffAddress: moved.address,
      dropoffLat: moved.lat,
      dropoffLng: moved.lng,
    });
  });

  it("does not move a routed trip of today, even for a new address", () => {
    expect(
      planTripChange(trip({ serviceDate: TODAY, routeId: "r1", routeVehicleType: "TAXI" }), { kind: "update", keyMinute: 480 }, TODAY),
    ).toEqual({ type: "deferred" });
  });
});

describe("nextSharingStatus", () => {
  it("withdraws eligibility but keeps a refusal", () => {
    expect(nextSharingStatus("PROPOSED", false)).toBe("NOT_ELIGIBLE");
    expect(nextSharingStatus("ACCEPTED", false)).toBe("NOT_ELIGIBLE");
    expect(nextSharingStatus("REFUSED", false)).toBe("REFUSED");
    expect(nextSharingStatus("NOT_ELIGIBLE", true)).toBe("NOT_PROPOSED");
    expect(nextSharingStatus("ACCEPTED", true)).toBe("ACCEPTED");
  });
});

describe("prescriptionTarget", () => {
  it("cancels trips outside the new validity", () => {
    expect(prescriptionTarget(trip({ serviceDate: "2026-11-20" }), { ...TAP_BOTH, validTo: "2026-11-15" })).toEqual(CANCEL);
    expect(prescriptionTarget(trip(), { ...TAP_BOTH, mode: "AMBULANCE" })).toEqual({
      kind: "update",
      prescription: { ...TAP_BOTH, mode: "AMBULANCE" },
    });
  });
});

describe("recurrenceTarget", () => {
  const before: RecurrenceSchedule = {
    facilityId: "f1",
    prescriptionId: "p1",
    weekdays: [1, 3, 5],
    appointmentMinute: 450,
    sessionMinutes: 240,
    legs: "BOTH",
    startDate: "2026-09-01",
    endDate: null,
  };
  const after = (changes: Partial<RecurrenceSchedule> = {}, prescription: PrescriptionRules & DateRange = TAP_BOTH) => ({
    ...before,
    ...changes,
    prescription,
    facility: CLINIC,
  });
  const wednesday = "2026-11-04";

  it("recognises the days, legs and period the recurrence still produces", () => {
    expect(recurrenceSchedules(before, wednesday, "RETURN")).toBe(true);
    expect(recurrenceSchedules(before, TOMORROW, "OUTBOUND")).toBe(false); // Tuesday
    expect(recurrenceSchedules({ ...before, legs: "OUTBOUND" }, wednesday, "RETURN")).toBe(false);
    expect(recurrenceSchedules({ ...before, endDate: "2026-11-03" }, wednesday, "OUTBOUND")).toBe(false);
  });

  it("cancels trips on a day, leg or period the recurrence no longer has", () => {
    const t = trip({ serviceDate: wednesday });
    expect(recurrenceTarget(t, before, after({ weekdays: [2, 4, 6] }))).toEqual(CANCEL);
    expect(recurrenceTarget(t, before, after({ legs: "RETURN" }))).toEqual(CANCEL);
    expect(recurrenceTarget(t, before, after({ startDate: "2026-11-05" }))).toEqual(CANCEL);
  });

  it("moves the times, except a time changed by hand", () => {
    const outbound = trip({ serviceDate: wednesday });
    expect(recurrenceTarget(outbound, before, after({ appointmentMinute: 480 }))).toMatchObject({ keyMinute: 480 });
    const manual = trip({ serviceDate: wednesday, appointmentMinute: 540 });
    expect(recurrenceTarget(manual, before, after({ appointmentMinute: 480 }))).toMatchObject({ keyMinute: undefined });
    const back = trip({ serviceDate: wednesday, direction: "RETURN", appointmentMinute: null, readyMinute: 690 });
    expect(recurrenceTarget(back, before, after({ sessionMinutes: 210 }))).toMatchObject({ keyMinute: 660 });
  });

  it("sends the trips to the new facility", () => {
    expect(recurrenceTarget(trip({ serviceDate: wednesday }), before, after({ facilityId: "f2" }))).toMatchObject({
      destination: { facilityId: "f2", place: CLINIC },
    });
  });

  it("attaches trips to the new prescription only where it is valid", () => {
    const renewal = { id: "p2", mode: "TAP" as const, sharing: "OUTBOUND" as const, validFrom: "2027-03-01", validTo: "2027-08-31" };
    const covered = trip({ serviceDate: "2027-03-03" });
    expect(recurrenceTarget(covered, before, after({ prescriptionId: "p2" }, renewal))).toMatchObject({ prescription: renewal });
    // Still inside the old prescription: keeps it.
    const stillOld = trip({ serviceDate: wednesday });
    expect(recurrenceTarget(stillOld, before, after({ prescriptionId: "p2" }, renewal))).toMatchObject({
      kind: "update",
      prescription: undefined,
    });
    // Covered by neither: cancelled.
    const uncovered = trip({ serviceDate: "2027-03-03", prescriptionValidity: { validFrom: "2026-09-01", validTo: "2027-02-28" } });
    expect(recurrenceTarget(uncovered, before, after({ prescriptionId: "p2" }, { ...renewal, validFrom: "2027-03-10" }))).toEqual(
      CANCEL,
    );
  });
});

describe("renewalTarget", () => {
  it("re-attaches only the trips inside the renewal", () => {
    const renewal = { id: "p2", mode: "TAP" as const, sharing: "BOTH" as const, validFrom: "2026-11-08", validTo: "2027-05-07" };
    expect(renewalTarget(trip({ serviceDate: "2026-11-09" }), renewal)).toEqual({ kind: "update", prescription: renewal });
    expect(renewalTarget(trip({ serviceDate: "2026-11-06" }), renewal)).toEqual({ kind: "update" });
  });
});

describe("sync summary", () => {
  it("describes what happened to the trips in French", () => {
    expect(describeSync({ updated: 0, cancelled: 0, detached: 0, deferred: 0 })).toBeNull();
    expect(describeSync({ updated: 1, cancelled: 0, detached: 0, deferred: 0 })).toBe("Courses à venir : 1 mise à jour.");
    expect(describeSync({ updated: 3, cancelled: 2, detached: 1, deferred: 2 })).toBe(
      "Courses à venir : 3 mises à jour, 2 annulées. 1 course a été retirée de sa tournée : réoptimisez la journée concernée. " +
        "2 courses d'aujourd'hui, déjà dans une tournée, n'ont pas été modifiées : ajustez-les dans Courses et prévenez les chauffeurs.",
    );
  });

  it("round-trips through the redirect URL", () => {
    const summary = { updated: 3, cancelled: 2, detached: 1, deferred: 0 };
    expect(encodeSync(summary)).toBe("3-2-1-0");
    expect(decodeSync("3-2-1-0")).toEqual(summary);
    expect(decodeSync("0-0-0-0")).toBeNull();
    expect(decodeSync("abc")).toBeNull();
    expect(decodeSync(undefined)).toBeNull();
    expect(withSyncNotice("/patients/x#prescriptions", summary)).toBe("/patients/x?courses=3-2-1-0#prescriptions");
    expect(withSyncNotice("/patients/x", summary)).toBe("/patients/x?courses=3-2-1-0");
    expect(withSyncNotice("/patients/x#recurrences", { updated: 0, cancelled: 0, detached: 0, deferred: 0 })).toBe(
      "/patients/x#recurrences",
    );
  });
});
