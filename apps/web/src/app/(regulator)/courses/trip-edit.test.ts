import { describe, expect, it } from "vitest";
import { fromIsoDate } from "@/lib/time";
import { describeEditChanges, planTripEdit, recurrenceMoveBlocker, type EditableTrip, type TripEdit } from "./trip-edit";

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

describe("planTripEdit", () => {
  it("writes nothing when nothing changed", () => {
    expect(planTripEdit(trip(), edit())).toEqual({ changes: [], data: {}, detach: false, checkFit: false });
  });

  it("writes notes without touching the route", () => {
    const plan = planTripEdit(trip(ROUTED), edit({ notes: "  Salle 3  " }));
    expect(plan).toEqual({ changes: ["notes"], data: { notes: "Salle 3" }, detach: false, checkFit: false });
    expect(planTripEdit(trip({ notes: "Salle 3" }), edit({ notes: "" })).data).toEqual({ notes: null });
  });

  it("moves a trip of a recurrence to another day: it keeps the session it serves, leaves its route and its lock", () => {
    const plan = planTripEdit(trip({ ...ROUTED, lockedVehicleId: "v1", lockedVehicleType: "TAXI" }), edit({ serviceDate: "2026-11-17" }));
    expect(plan.changes).toEqual(["date"]);
    expect(plan.detach).toBe(true);
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
    expect(plan).toEqual({ changes: ["time"], data: { appointmentMinute: 480 }, detach: false, checkFit: true });
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

  it("says what changed in French", () => {
    expect(describeEditChanges(["date"])).toBe("date");
    expect(describeEditChanges(["date", "home", "notes"])).toBe("date, adresse du patient et notes");
  });
});

describe("recurrenceMoveBlocker", () => {
  const move = (overrides: Partial<Parameters<typeof recurrenceMoveBlocker>[0]> = {}) =>
    recurrenceMoveBlocker({ ownSession: false, schedulesThatDay: true, sameSessionTrip: null, ...overrides }, "17/11");

  it("lets a trip move to a day its recurrence does not plan, back to its own day, or to a session a person cancelled", () => {
    expect(move({ schedulesThatDay: false })).toBeNull();
    expect(move({ ownSession: true })).toBeNull();
    expect(move({ sameSessionTrip: { status: "CANCELLED", cancellationOrigin: "USER" } })).toBeNull();
    expect(move({ sameSessionTrip: { status: "NO_SHOW", cancellationOrigin: null } })).toBeNull();
  });

  it("refuses a day the recurrence already serves, or will (a trip the application cancelled may come back)", () => {
    expect(move({ sameSessionTrip: { status: "PLANNED", cancellationOrigin: null } })).toMatch(/déjà une course le 17\/11/);
    expect(move({ sameSessionTrip: { status: "CANCELLED", cancellationOrigin: "SYSTEM" } })).toMatch(/déjà une course/);
    expect(move()).toMatch(/prévoit déjà une séance le 17\/11/);
  });
});
