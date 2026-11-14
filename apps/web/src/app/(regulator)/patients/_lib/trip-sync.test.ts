import { beforeAll, describe, expect, it } from "vitest";
import {
  CANCEL,
  decodeSync,
  describeSync,
  EMPTY_SYNC,
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
    occurrenceDate: null,
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
    oneOffAddress: false,
    notes: null,
    recurrenceId: "r1",
    routeId: null,
    routeVehicleType: null,
    lockedVehicleId: null,
    lockedVehicleType: null,
    exceptionalAmbulance: false,
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
  it("moves a trip outside the new validity to the renewal covering it, and cancels it only without one", () => {
    const renewal = { id: "p2", mode: "TAP" as const, sharing: "OUTBOUND" as const };
    expect(prescriptionTarget(trip({ serviceDate: "2026-11-20" }), { ...TAP_BOTH, validTo: "2026-11-15" }, renewal)).toEqual({
      kind: "update",
      prescription: renewal,
    });
  });

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
    notes: null,
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

  it("judges a trip moved to another day on the session it serves", () => {
    // Monday's session moved to Tuesday (not a day of the recurrence): kept while Monday stays a day of it.
    const moved = trip({ serviceDate: TOMORROW, occurrenceDate: TODAY });
    expect(recurrenceTarget(moved, before, after({ appointmentMinute: 480 }))).toMatchObject({ kind: "update", keyMinute: 480 });
    expect(recurrenceTarget(moved, before, after({ weekdays: [3, 5] }))).toEqual(CANCEL);
  });

  it("copies new notes, except notes changed by hand", () => {
    const copied = trip({ serviceDate: wednesday, notes: "Salle 3" });
    const old = { ...before, notes: "Salle 3" };
    expect(recurrenceTarget(copied, old, after({ notes: "Salle 5" }))).toMatchObject({ notes: "Salle 5" });
    expect(recurrenceTarget(copied, old, after({ notes: null }))).toMatchObject({ notes: null });
    const typed = trip({ serviceDate: wednesday, notes: "Chez sa fille cette semaine" });
    expect(recurrenceTarget(typed, old, after({ notes: "Salle 5" }))).toMatchObject({ notes: undefined });
    expect(recurrenceTarget(copied, old, after({ notes: "Salle 3" }))).toMatchObject({ notes: undefined });
  });

  it("cancels the trips of the weeks off once the recurrence comes back every other week (PAT-05)", () => {
    // From the week of 2026-09-01 (Monday 2026-08-31), 9 weeks before that of 2026-11-02: the weeks of 2026-11-09 and
    // 2026-11-23 are on, those of 2026-11-02 and 2026-11-16 off.
    const everyOther = after({ intervalWeeks: 2 });
    expect(recurrenceTarget(trip({ serviceDate: "2026-11-11" }), before, everyOther)).toMatchObject({ kind: "update" });
    expect(recurrenceTarget(trip({ serviceDate: wednesday }), before, everyOther)).toEqual(CANCEL);
    // Explicit dates: only those days keep their trip.
    const dated = after({ sessionDates: ["2026-11-04"], startDate: "2026-11-04", endDate: "2026-11-04" });
    expect(recurrenceTarget(trip({ serviceDate: wednesday }), before, dated)).toMatchObject({ kind: "update" });
    expect(recurrenceTarget(trip({ serviceDate: "2026-11-06" }), before, dated)).toEqual(CANCEL);
  });

  it("moves the times of the weekday given its own time only (PAT-05)", () => {
    const own = after({ daySchedules: [{ weekday: 3, appointmentMinute: 780, sessionMinutes: 180 }] });
    expect(recurrenceTarget(trip({ serviceDate: wednesday }), before, own)).toMatchObject({ keyMinute: 780 });
    expect(recurrenceTarget(trip({ serviceDate: "2026-11-06" }), before, own)).toMatchObject({ keyMinute: undefined });
    const back = trip({ serviceDate: wednesday, direction: "RETURN", appointmentMinute: null, readyMinute: 690 });
    expect(recurrenceTarget(back, before, own)).toMatchObject({ keyMinute: 960 });
    // Back to the common time: the trip of that weekday follows.
    const moved = trip({ serviceDate: wednesday, appointmentMinute: 780 });
    expect(recurrenceTarget(moved, { ...before, daySchedules: own.daySchedules }, after())).toMatchObject({ keyMinute: 450 });
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
    // …unless the generation would put it on another PMT of the chain that day.
    const bridge = { id: "p3", mode: "TAP" as const, sharing: "BOTH" as const };
    expect(
      recurrenceTarget(uncovered, before, after({ prescriptionId: "p2" }, { ...renewal, validFrom: "2027-03-10" }), bridge),
    ).toMatchObject({ kind: "update", prescription: bridge });
  });
});

describe("one-off address and notes", () => {
  it("never moves a one-off address with the patient's home", () => {
    const elsewhere = { address: "8 rue des Lilas, 04000 Digne-les-Bains", lat: 44.09, lng: 6.23 };
    const oneOff = trip({ oneOffAddress: true, pickupAddress: elsewhere.address, pickupLat: elsewhere.lat, pickupLng: elsewhere.lng });
    expect(planTripChange(oneOff, { kind: "update", home: { address: "Nouveau domicile", lat: 43.9, lng: 5.8 } }, TODAY)).toEqual({
      type: "none",
    });
    // The care side still follows its facility.
    const moved = planTripChange(oneOff, { kind: "update", destination: { facilityId: "f2", place: CLINIC } }, TODAY);
    expect(moved).toMatchObject({ type: "change", change: { data: { facilityId: "f2" } } });
  });

  it("writes new notes without taking the trip out of its route", () => {
    const routed = trip({ status: "ASSIGNED", routeId: "route1", routeVehicleType: "TAXI", notes: "Salle 3" });
    expect(planTripChange(routed, { kind: "update", notes: "Salle 5" }, TODAY)).toEqual({
      type: "change",
      change: { tripId: "t1", expectedStatus: "ASSIGNED", cancel: false, detach: false, data: { notes: "Salle 5" } },
    });
    expect(planTripChange(routed, { kind: "update", notes: "Salle 3" }, TODAY)).toEqual({ type: "none" });
  });
});

describe("exceptional ambulance (TAR-03)", () => {
  // A seated trip locked on, and routed in, an ambulance by « recours exceptionnel ».
  const exceptional = (overrides: Partial<SyncTrip> = {}) =>
    trip({
      status: "ASSIGNED",
      routeId: "route1",
      routeVehicleType: "AMBULANCE",
      lockedVehicleId: "amb1",
      lockedVehicleType: "AMBULANCE",
      exceptionalAmbulance: true,
      notes: "Salle 3",
      ...overrides,
    });

  it("keeps its lock and its route when the recurrence's notes change", () => {
    expect(planTripChange(exceptional(), { kind: "update", notes: "Salle 5" }, TODAY)).toEqual({
      type: "change",
      change: { tripId: "t1", expectedStatus: "ASSIGNED", cancel: false, detach: false, data: { notes: "Salle 5" } },
    });
  });

  it("keeps its lock on a new time (out of its route, to be placed again on its ambulance) and on another seated PMT", () => {
    const time = planTripChange(exceptional(), { kind: "update", keyMinute: 480 }, TODAY);
    expect(time).toMatchObject({ type: "change", change: { detach: true, data: { appointmentMinute: 480, routeId: null } } });
    expect(time.type === "change" && time.change.data).not.toHaveProperty("lockedVehicleId");

    const renewal = planTripChange(exceptional(), { kind: "update", prescription: { id: "p2", mode: "TAP", sharing: "BOTH" } }, TODAY);
    expect(renewal).toEqual({
      type: "change",
      change: { tripId: "t1", expectedStatus: "ASSIGNED", cancel: false, detach: false, data: { prescriptionId: "p2" } },
    });
  });

  it("ends the measure, keeping the ambulance, once the trip is prescribed in ambulance", () => {
    const decision = planTripChange(exceptional(), { kind: "update", prescription: { id: "p1", mode: "AMBULANCE", sharing: "NONE" } }, TODAY);
    expect(decision.type === "change" && decision.change.data).toMatchObject({
      allowedVehicleTypes: ["AMBULANCE"],
      exceptionalAmbulanceAt: null,
      exceptionalAmbulanceById: null,
    });
    expect(decision.type === "change" && decision.change.data).not.toHaveProperty("lockedVehicleId");
    expect(decision.type === "change" && decision.change.detach).toBe(false);
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
    expect(describeSync({ updated: 0, cancelled: 0, detached: 0, deferred: 0, created: 0, revived: 0 })).toBeNull();
    expect(describeSync({ updated: 1, cancelled: 0, detached: 0, deferred: 0, created: 0, revived: 0 })).toBe("Courses à venir\u00a0: 1 mise à jour.");
    expect(describeSync({ updated: 3, cancelled: 2, detached: 1, deferred: 2, created: 0, revived: 0 })).toBe(
      "Courses à venir\u00a0: 3 mises à jour, 2 annulées. 1 course a été retirée de sa tournée\u00a0: réoptimisez la journée concernée. " +
        "2 courses d'aujourd'hui, déjà dans une tournée, n'ont pas été modifiées\u00a0: ajustez-les dans Courses et prévenez les chauffeurs.",
    );
  });

  it("tells the trips created and brought back by the horizon completion first", () => {
    expect(describeSync({ ...EMPTY_SYNC, created: 12, revived: 1, cancelled: 2 })).toBe("Courses à venir\u00a0: 12 créées, 1 rétablie, 2 annulées.");
    const summary = { ...EMPTY_SYNC, created: 12, revived: 1 };
    expect(encodeSync(summary)).toBe("0-0-0-0-12-1");
    expect(decodeSync("0-0-0-0-12-1")).toEqual(summary);
    expect(decodeSync("0-0-0-0-0-0")).toBeNull();
    expect(decodeSync("1-0-0-0-5")).toBeNull();
  });

  it("round-trips through the redirect URL", () => {
    const summary = { updated: 3, cancelled: 2, detached: 1, deferred: 0, created: 0, revived: 0 };
    expect(encodeSync(summary)).toBe("3-2-1-0");
    expect(decodeSync("3-2-1-0")).toEqual(summary);
    expect(decodeSync("0-0-0-0")).toBeNull();
    expect(decodeSync("abc")).toBeNull();
    expect(decodeSync(undefined)).toBeNull();
    expect(withSyncNotice("/patients/x#prescriptions", summary)).toBe("/patients/x?courses=3-2-1-0#prescriptions");
    expect(withSyncNotice("/patients/x", summary)).toBe("/patients/x?courses=3-2-1-0");
    expect(withSyncNotice("/patients/x#recurrences", { updated: 0, cancelled: 0, detached: 0, deferred: 0, created: 0, revived: 0 })).toBe(
      "/patients/x#recurrences",
    );
  });
});
