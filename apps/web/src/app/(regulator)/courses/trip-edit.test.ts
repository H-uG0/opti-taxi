import { describe, expect, it } from "vitest";
import { fromIsoDate } from "@/lib/time";
import {
  describeEditChanges,
  planTripEdit,
  recurrenceMoveBlocker,
  type EditableTrip,
  type RecurrenceTripNearby,
  type TripEdit,
} from "./trip-edit";

const HOME = { address: "4 avenue Jean Jaurès, 04100 Manosque", lat: 43.8297, lng: 5.7864 };
const CLINIC = { address: "1 rue de l'Hôpital, 04100 Manosque", lat: 43.83, lng: 5.79 };
const DAUGHTER = { address: "8 rue des Lilas, 04000 Digne-les-Bains", lat: 44.09, lng: 6.23 };
const OTHER_CLINIC = { address: "Centre de repli, 04000 Digne-les-Bains", lat: 44.1, lng: 6.24 };

function trip(overrides: Partial<EditableTrip> = {}): EditableTrip {
  return {
    id: "t1",
    status: "PLANNED",
    serviceDate: "2026-11-16",
    occurrenceDate: "2026-11-16",
    recurrenceId: "r1",
    direction: "OUTBOUND",
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
    routeId: null,
    routeVehicleType: null,
    lockedVehicleId: null,
    lockedVehicleType: null,
    exceptionalAmbulance: false,
    ...overrides,
  };
}

function edit(overrides: Partial<TripEdit> = {}): TripEdit {
  return {
    serviceDate: "2026-11-16",
    keyMinute: 450,
    home: { place: HOME, oneOff: false },
    care: { facilityId: "f1", place: CLINIC },
    notes: null,
    prescription: { id: "p1", allowedVehicleTypes: ["TAXI", "VSL"], sharingAllowed: true },
    ...overrides,
  };
}

const ROUTED = { status: "ASSIGNED" as const, routeId: "route1", routeVehicleType: "TAXI" as const };
const KEPT = { unlocked: false, exceptionalWithdrawn: false };
/** « Recours exceptionnel à une ambulance »: a seated trip locked on, and routed in, an ambulance. */
const EXCEPTIONAL = {
  ...ROUTED,
  routeVehicleType: "AMBULANCE" as const,
  lockedVehicleId: "amb1",
  lockedVehicleType: "AMBULANCE" as const,
  exceptionalAmbulance: true,
};

describe("planTripEdit", () => {
  it("writes nothing when nothing changed", () => {
    expect(planTripEdit(trip(), edit())).toEqual({ changes: [], data: {}, detach: false, checkFit: false, ...KEPT });
  });

  it("writes notes without touching the route", () => {
    const plan = planTripEdit(trip(ROUTED), edit({ notes: "  Salle 3  " }));
    expect(plan).toEqual({ changes: ["notes"], data: { notes: "Salle 3" }, detach: false, checkFit: false, ...KEPT });
    expect(planTripEdit(trip({ notes: "Salle 3" }), edit({ notes: "" })).data).toEqual({ notes: null });
  });

  it("moves a trip of a recurrence to another day: it keeps the session it serves, leaves its route and its lock", () => {
    const plan = planTripEdit(trip({ ...ROUTED, lockedVehicleId: "v1", lockedVehicleType: "TAXI" }), edit({ serviceDate: "2026-11-17" }));
    expect(plan.changes).toEqual(["date"]);
    expect(plan.detach).toBe(true);
    expect(plan).toMatchObject({ unlocked: true, exceptionalWithdrawn: false });
    expect(plan.data).toMatchObject({
      serviceDate: fromIsoDate("2026-11-17"),
      occurrenceDate: fromIsoDate("2026-11-16"),
      lockedVehicleId: null,
      routeId: null,
      status: "PLANNED",
      shared: false,
    });
  });

  it("keeps the first session served when a moved trip moves again, and gives a one-off trip none", () => {
    const again = planTripEdit(trip({ serviceDate: "2026-11-17", occurrenceDate: "2026-11-16" }), edit({ serviceDate: "2026-11-18" }));
    expect(again.data.occurrenceDate).toEqual(fromIsoDate("2026-11-16"));
    const oneOff = planTripEdit(trip({ recurrenceId: null, occurrenceDate: null }), edit({ serviceDate: "2026-11-18" }));
    expect(oneOff.data).not.toHaveProperty("occurrenceDate");
  });

  it("takes a one-off address on the home side of an outbound trip, and back home later", () => {
    const away = planTripEdit(trip(ROUTED), edit({ home: { place: DAUGHTER, oneOff: true } }));
    expect(away.changes).toEqual(["home"]);
    expect(away.detach).toBe(true);
    expect(away.data).toMatchObject({ pickupAddress: DAUGHTER.address, pickupLat: DAUGHTER.lat, oneOffAddress: true });
    expect(away.data).not.toHaveProperty("dropoffAddress");

    const back = trip({ oneOffAddress: true, pickupAddress: DAUGHTER.address, pickupLat: DAUGHTER.lat, pickupLng: DAUGHTER.lng });
    expect(planTripEdit(back, edit()).data).toMatchObject({ pickupAddress: HOME.address, oneOffAddress: false });
  });

  it("puts the home side of a return trip on its drop-off", () => {
    const ret = trip({
      direction: "RETURN",
      appointmentMinute: null,
      readyMinute: 690,
      pickupAddress: CLINIC.address,
      pickupLat: CLINIC.lat,
      pickupLng: CLINIC.lng,
      dropoffAddress: HOME.address,
      dropoffLat: HOME.lat,
      dropoffLng: HOME.lng,
    });
    const plan = planTripEdit(ret, edit({ keyMinute: 690, home: { place: DAUGHTER, oneOff: true }, care: { facilityId: "f2", place: OTHER_CLINIC } }));
    expect(plan.changes).toEqual(["home", "facility"]);
    expect(plan.data).toMatchObject({
      dropoffAddress: DAUGHTER.address,
      pickupAddress: OTHER_CLINIC.address,
      facilityId: "f2",
      oneOffAddress: true,
    });
  });

  it("checks the fit of a time change on a routed trip instead of taking it out", () => {
    const plan = planTripEdit(trip(ROUTED), edit({ keyMinute: 480 }));
    expect(plan).toEqual({ changes: ["time"], data: { appointmentMinute: 480 }, detach: false, checkFit: true, ...KEPT });
    expect(planTripEdit(trip(), edit({ keyMinute: 480 })).checkFit).toBe(false);
  });

  it("follows the prescription of the new date: vehicle types and sharing, out of a route that no longer fits", () => {
    const ambulance = { id: "p2", allowedVehicleTypes: ["AMBULANCE" as const], sharingAllowed: false };
    const plan = planTripEdit(
      trip({ ...ROUTED, shared: true, sharingStatus: "ACCEPTED", lockedVehicleId: "v1", lockedVehicleType: "TAXI" }),
      edit({ prescription: ambulance }),
    );
    expect(plan.changes).toEqual(["prescription"]);
    expect(plan.detach).toBe(true);
    expect(plan.data).toMatchObject({
      prescriptionId: "p2",
      allowedVehicleTypes: ["AMBULANCE"],
      sharingAllowed: false,
      sharingStatus: "NOT_ELIGIBLE",
      lockedVehicleId: null,
    });
  });

  it("keeps an exceptional ambulance, its lock and its route when only the notes, the time or a place change", () => {
    const notes = planTripEdit(trip(EXCEPTIONAL), edit({ notes: "Salle 5" }));
    expect(notes).toEqual({ changes: ["notes"], data: { notes: "Salle 5" }, detach: false, checkFit: false, ...KEPT });

    const time = planTripEdit(trip(EXCEPTIONAL), edit({ keyMinute: 480 }));
    expect(time).toEqual({ changes: ["time"], data: { appointmentMinute: 480 }, detach: false, checkFit: true, ...KEPT });

    // Another address takes it out of its route, not off its ambulance: the optimizer puts it back there.
    const away = planTripEdit(trip(EXCEPTIONAL), edit({ home: { place: DAUGHTER, oneOff: true } }));
    expect(away.detach).toBe(true);
    expect(away).toMatchObject(KEPT);
    expect(away.data).not.toHaveProperty("lockedVehicleId");
    expect(away.data).not.toHaveProperty("exceptionalAmbulanceAt");
  });

  it("ends an exceptional ambulance with its lock when the trip moves to another day", () => {
    const plan = planTripEdit(trip(EXCEPTIONAL), edit({ serviceDate: "2026-11-17" }));
    expect(plan).toMatchObject({ detach: true, unlocked: true, exceptionalWithdrawn: true });
    expect(plan.data).toMatchObject({ lockedVehicleId: null, exceptionalAmbulanceAt: null, exceptionalAmbulanceById: null, routeId: null });
  });

  it("still drops a lock on an ambulance that is no exceptional measure", () => {
    const plan = planTripEdit(trip({ ...EXCEPTIONAL, exceptionalAmbulance: false }), edit({ notes: "Salle 5" }));
    expect(plan).toMatchObject({ detach: true, unlocked: true, exceptionalWithdrawn: false });
  });

  it("says what changed in French", () => {
    expect(describeEditChanges(["date"])).toBe("date");
    expect(describeEditChanges(["date", "home", "notes"])).toBe("date, adresse du patient et notes");
  });
});

describe("recurrenceMoveBlocker", () => {
  const DAY = "2026-11-17";
  const move = (overrides: Partial<Parameters<typeof recurrenceMoveBlocker>[0]> = {}) =>
    recurrenceMoveBlocker({ newDate: DAY, ownSession: false, schedulesThatDay: true, others: [], ...overrides }, "17/11");
  const other = (overrides: Partial<RecurrenceTripNearby> = {}): RecurrenceTripNearby => ({
    status: "PLANNED",
    cancellationOrigin: null,
    serviceDate: DAY,
    occurrenceDate: DAY,
    ...overrides,
  });

  it("lets a trip move to a day its recurrence does not plan, back to its own day, or to a session a person cancelled", () => {
    expect(move({ schedulesThatDay: false })).toBeNull();
    expect(move({ ownSession: true })).toBeNull();
    expect(move({ others: [other({ status: "CANCELLED", cancellationOrigin: "USER" })] })).toBeNull();
    expect(move({ others: [other({ status: "NO_SHOW" })] })).toBeNull();
  });

  it("refuses a day the recurrence already serves, or will (a trip the application cancelled may come back)", () => {
    expect(move({ others: [other()] })).toMatch(/déjà une course le 17\/11/);
    expect(move({ others: [other({ status: "CANCELLED", cancellationOrigin: "SYSTEM" })] })).toMatch(/déjà une course/);
    expect(move()).toMatch(/prévoit déjà une séance le 17\/11/);
  });

  it("lets a trip take the day of a session whose own trip was moved to another day", () => {
    expect(move({ others: [other({ serviceDate: "2026-11-18" })] })).toBeNull();
    expect(move({ others: [other({ serviceDate: "2026-11-18", status: "CANCELLED", cancellationOrigin: "SYSTEM" })] })).toBeNull();
  });

  it("refuses a day another trip of the recurrence was already moved to, even off its days or back to its own session", () => {
    const movedThere = other({ occurrenceDate: "2026-11-16" });
    expect(move({ schedulesThatDay: false, others: [movedThere] })).toMatch(/déjà une course le 17\/11/);
    expect(move({ ownSession: true, others: [movedThere] })).toMatch(/déjà une course/);
    expect(move({ schedulesThatDay: false, others: [{ ...movedThere, status: "CANCELLED", cancellationOrigin: "USER" }] })).toBeNull();
  });
});
