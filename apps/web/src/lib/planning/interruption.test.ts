import { describe, expect, it } from "vitest";
import {
  continuationData,
  continuationPlace,
  interruptionMessage,
  planInterruption,
  type InterruptedTrip,
  type InterruptStop,
} from "./interruption";

const DONE = new Date("2026-11-14T09:00:00Z");

function stop(tripId: string, kind: "PICKUP" | "DROPOFF", sequence: number, start: number, completedAt: Date | null = null): InterruptStop {
  return { id: `${tripId}-${kind}`, tripId, kind, sequence, startMinute: start, departureMinute: start + 5, completedAt };
}

/** t1 dropped off, t2 on board, t3 and t4 still to do (t4 ends at 13:05). */
const stops = [
  stop("t1", "PICKUP", 0, 480, DONE),
  stop("t1", "DROPOFF", 1, 510, DONE),
  stop("t2", "PICKUP", 2, 600, DONE),
  stop("t2", "DROPOFF", 3, 650),
  stop("t3", "PICKUP", 4, 700),
  stop("t4", "PICKUP", 5, 720),
  stop("t4", "DROPOFF", 6, 780),
  stop("t3", "DROPOFF", 7, 800),
];

describe("planInterruption (DAY-03)", () => {
  it("from now: keeps what was done, picks a patient on board up again, takes off what is not picked up", () => {
    const plan = planInterruption({ stops, statusOf: () => undefined, fromMinute: 620, nowMinute: 625 });
    expect(plan.keptStopIds).toEqual(["t1-PICKUP", "t1-DROPOFF", "t2-PICKUP"]);
    expect(plan.removedStopIds).toEqual(["t2-DROPOFF", "t3-PICKUP", "t4-PICKUP", "t4-DROPOFF", "t3-DROPOFF"]);
    expect(plan.interruptedTripIds).toEqual(["t2"]);
    expect(plan.detachedTripIds).toEqual(["t3", "t4"]);
    expect(plan.lastDoneStopId).toBe("t2-PICKUP");
    expect(plan.lastKeptDeparture).toBe(605);
  });

  it("reads a stop done from its trip's status too (picked up on the phone before the stop was recorded)", () => {
    const plan = planInterruption({
      stops: stops.map((s) => ({ ...s, completedAt: null })),
      statusOf: (id) => (id === "t1" ? "DROPPED_OFF" : id === "t2" ? "PICKED_UP" : "ASSIGNED"),
      fromMinute: 620,
      nowMinute: 625,
    });
    expect(plan.interruptedTripIds).toEqual(["t2"]);
    expect(plan.detachedTripIds).toEqual(["t3", "t4"]);
  });

  it("from a later time: keeps the trips planned to end before it and the patient on board, takes off the others", () => {
    const plan = planInterruption({ stops, statusOf: () => undefined, fromMinute: 790, nowMinute: 625 });
    // t4 ends at 13:05 (785), before 13:10; t3 ends after.
    expect(plan.detachedTripIds).toEqual(["t3"]);
    expect(plan.keptOnBoardTripIds).toEqual(["t2"]);
    expect(plan.interruptedTripIds).toEqual([]);
    expect(plan.removedStopIds).toEqual(["t3-PICKUP", "t3-DROPOFF"]);
    // A later date: nothing is under way; t1 and t2 end before 11:40.
    expect(planInterruption({ stops: stops.map((s) => ({ ...s, completedAt: null })), statusOf: () => undefined, fromMinute: 700, nowMinute: null }).detachedTripIds).toEqual([
      "t3",
      "t4",
    ]);
  });

  it("says what it did", () => {
    const plan = planInterruption({ stops, statusOf: () => undefined, fromMinute: 620, nowMinute: 625 });
    expect(interruptionMessage({ vehicleLabel: "Taxi 3 (Aix)", who: "VEHICLE", fromMinute: 620, plan })).toBe(
      "Taxi 3 (Aix) hors service à partir de 10:20\u00a0: 3 courses à replacer, 1 patient à bord attend près du véhicule (1 course de reprise créée, à placer en premier).",
    );
    const later = planInterruption({ stops, statusOf: () => undefined, fromMinute: 790, nowMinute: 625 });
    expect(interruptionMessage({ vehicleLabel: "VSL 2", who: "DRIVER", fromMinute: 790, plan: later })).toBe(
      "VSL 2 sans chauffeur à partir de 13:10\u00a0: 1 course à replacer, 1 patient à bord reste jusqu'à sa dépose.",
    );
  });

  it("never interrupts nor takes off a trip closed: a patient absent, a cancellation, an earlier interruption", () => {
    // t2 picked up, then the patient of t3 was absent (its pickup done, its dropoff left on the route); t5 was
    // interrupted earlier (its pickup kept done, its dropoff gone); t6 was cancelled before its pickup.
    const closed = [
      ...stops.slice(0, 4),
      stop("t3", "PICKUP", 4, 700, DONE),
      stop("t5", "PICKUP", 5, 705, DONE),
      stop("t6", "PICKUP", 6, 710),
      stop("t6", "DROPOFF", 7, 730),
      stop("t3", "DROPOFF", 8, 800),
    ];
    const status = (id: string) => (({ t1: "DROPPED_OFF", t2: "PICKED_UP", t3: "NO_SHOW", t5: "CANCELLED", t6: "CANCELLED" }) as const)[id];
    const plan = planInterruption({ stops: closed, statusOf: status, fromMinute: 740, nowMinute: 745 });
    expect(plan.interruptedTripIds).toEqual(["t2"]);
    expect(plan.detachedTripIds).toEqual([]);
    // The absent patient's pickup and the earlier interruption stay done on the route; what was left of them goes.
    expect(plan.keptStopIds).toEqual(["t1-PICKUP", "t1-DROPOFF", "t2-PICKUP", "t3-PICKUP", "t5-PICKUP"]);
    expect(plan.removedStopIds).toEqual(["t2-DROPOFF", "t6-PICKUP", "t6-DROPOFF", "t3-DROPOFF"]);
    expect(plan.nothingLeft).toBe(false);
  });

  it("finds nothing to interrupt on a route already interrupted (a second click, a stale page)", () => {
    const after = [stop("t1", "PICKUP", 0, 480, DONE), stop("t1", "DROPOFF", 1, 510, DONE), stop("t2", "PICKUP", 2, 600, DONE)];
    const status = (id: string) => (id === "t1" ? "DROPPED_OFF" : "CANCELLED") as "DROPPED_OFF" | "CANCELLED";
    const plan = planInterruption({ stops: after, statusOf: status, fromMinute: 620, nowMinute: 625 });
    expect(plan.nothingLeft).toBe(true);
    expect(plan.interruptedTripIds).toEqual([]);
    expect(plan.removedStopIds).toEqual([]);
    expect(planInterruption({ stops, statusOf: () => undefined, fromMinute: 620, nowMinute: 625 }).nothingLeft).toBe(false);
  });
});

const interrupted: InterruptedTrip = {
  id: "t2",
  serviceDate: new Date("2026-11-16T00:00:00Z"),
  direction: "RETURN",
  patientId: "p2",
  prescriptionId: "rx2",
  facilityId: "fac",
  payer: "CPAM",
  allowedVehicleTypes: ["VSL", "TAXI"],
  pickupAddress: "Centre de radiothérapie, 23 rue du Moucherotte, 38000 Grenoble",
  dropoffAddress: "4 rue des Écoles, 05130 Tallard",
  dropoffLat: 44.46,
  dropoffLng: 6.05,
  appointmentMinute: null,
  readyMinute: 600,
  sharingAllowed: true,
  sharingStatus: "REFUSED",
  sharingRespondedAt: new Date("2026-11-10T09:00:00Z"),
  sharingRespondedById: "user-1",
  sharingNote: "Préfère voyager seul",
};

describe("continuationData (course de reprise, DAY-03)", () => {
  const place = { address: "Aire de Sisteron, A51", lat: 44.2, lng: 5.94 };

  it("copies the patient, leg, prescription, facility and vehicle types, and keeps the refusal to share with its trace", () => {
    const data = continuationData({ trip: interrupted, place, fromMinute: 660, nowMinute: 680, vehicleLabel: "Taxi 59 (Grenoble)", who: "VEHICLE" });
    expect(data).toMatchObject({
      direction: "RETURN",
      patientId: "p2",
      prescriptionId: "rx2",
      facilityId: "fac",
      payer: "CPAM",
      allowedVehicleTypes: ["VSL", "TAXI"],
      pickupAddress: "Aire de Sisteron, A51",
      pickupLat: 44.2,
      pickupLng: 5.94,
      dropoffAddress: "4 rue des Écoles, 05130 Tallard",
      appointmentMinute: null,
      // Ready from now (the interruption was recorded 20 min later), never from the end of the session.
      readyMinute: 680,
      sharingAllowed: true,
      sharingStatus: "REFUSED",
      sharingRespondedAt: interrupted.sharingRespondedAt,
      sharingRespondedById: "user-1",
      sharingNote: "Préfère voyager seul",
      continuesTripId: "t2",
      interruptedAtMinute: 660,
      oneOffAddress: false,
      notes: "Taxi 59 (Grenoble) hors service à 11:00, course de reprise créée.",
    });
    expect(data).not.toHaveProperty("recurrenceId");
    expect(data).not.toHaveProperty("lockedVehicleId");
  });

  it("keeps an outbound's appointment and proposes sharing again after an acceptance", () => {
    const outbound = { ...interrupted, direction: "OUTBOUND" as const, appointmentMinute: 840, readyMinute: null, sharingStatus: "ACCEPTED" as const };
    const data = continuationData({ trip: outbound, place, fromMinute: 700, nowMinute: null, vehicleLabel: "VSL 1", who: "DRIVER" });
    expect(data).toMatchObject({ appointmentMinute: 840, readyMinute: null, oneOffAddress: true, sharingStatus: "NOT_PROPOSED" });
    expect(data).not.toHaveProperty("sharingNote");
    expect(data.notes).toBe("VSL 1 sans chauffeur à 11:40, course de reprise créée.");
  });
});

describe("continuationPlace", () => {
  const base = { ownPickup: { address: "Chez le patient", lat: 1, lng: 2 }, tripId: "t2", vehicleLabel: "VSL 1", fromMinute: 660 };
  const lastDone = { tripId: "t2", kind: "PICKUP" as const, address: "Centre de dialyse", lat: 3, lng: 4, direction: "RETURN" as const };

  it("takes the place given, else the last stop done when it is the patient's own or a facility", () => {
    expect(continuationPlace({ ...base, given: { address: "Aire de Lançon", lat: 5, lng: 6 }, lastDone })).toEqual({ address: "Aire de Lançon", lat: 5, lng: 6 });
    expect(continuationPlace({ ...base, given: null, lastDone })).toEqual({ address: "Centre de dialyse", lat: 3, lng: 4 });
    // Another patient's outbound dropoff: a facility, named.
    const facility = { ...lastDone, tripId: "t9", kind: "DROPOFF" as const, direction: "OUTBOUND" as const, address: "Hôpital Nord" };
    expect(continuationPlace({ ...base, given: null, lastDone: facility }).address).toBe("Hôpital Nord");
    expect(continuationPlace({ ...base, given: null, lastDone: null })).toEqual(base.ownPickup);
  });

  it("never copies another patient's home onto this trip", () => {
    const home = { ...lastDone, tripId: "t9", kind: "PICKUP" as const, direction: "OUTBOUND" as const, address: "12 rue de B, Gap" };
    expect(continuationPlace({ ...base, given: null, lastDone: home })).toEqual({ address: "Lieu de l'interruption (VSL 1, 11:00)", lat: 3, lng: 4 });
  });
});
