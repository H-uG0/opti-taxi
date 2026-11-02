import { describe, expect, it } from "vitest";
import {
  countPatients,
  groupSharedTransports,
  parseFacilityFilter,
  sharedArrivalsHref,
  type SharedTransportTrip,
} from "./grouping";

const dialysis = { id: "fac_d", name: "Centre de dialyse Saint-Jean", type: "DIALYSIS" as const, phone: "04 91 00 00 00", address: "1 rue A, 13005 Marseille" };
const chu = { id: "fac_c", name: "CHU de la Timone", type: "HOSPITAL" as const, phone: null, address: "264 rue Saint-Pierre, 13005 Marseille" };
const taxi1 = { id: "veh_1", label: "Taxi 1", type: "TAXI" as const };
const vsl2 = { id: "veh_2", label: "VSL 2", type: "VSL" as const };

function trip(overrides: Partial<SharedTransportTrip> & { id: string }): SharedTransportTrip {
  return {
    direction: "OUTBOUND",
    patientName: overrides.id,
    facility: dialysis,
    vehicle: taxi1,
    driverName: "Paul Durand",
    routeValidated: true,
    plannedPickupMinute: null,
    plannedDropoffMinute: null,
    appointmentMinute: null,
    readyMinute: null,
    // By default, on board with a patient going elsewhere (shared according to the stops).
    coPassengerIds: ["elsewhere"],
    sharingRefused: false,
    ...overrides,
  };
}

describe("groupSharedTransports", () => {
  it("groups co-passengers of one vehicle arriving at the same facility", () => {
    const facilities = groupSharedTransports([
      trip({ id: "B", patientName: "MARTIN Paul", plannedDropoffMinute: 445, appointmentMinute: 450, coPassengerIds: ["A"] }),
      trip({ id: "A", patientName: "DUPONT Marie", plannedDropoffMinute: 440, appointmentMinute: 450, coPassengerIds: ["B"] }),
      // Same vehicle, back later with another patient: a separate passage.
      trip({ id: "C", patientName: "LEROY Anne", plannedDropoffMinute: 600, appointmentMinute: 610, coPassengerIds: ["X"] }),
      // Another vehicle at the same time: its own group.
      trip({ id: "D", patientName: "BLANC Luc", vehicle: vsl2, driverName: null, plannedDropoffMinute: 442, coPassengerIds: ["E"] }),
    ]);

    expect(facilities).toHaveLength(1);
    const [f] = facilities;
    expect(f?.facility.id).toBe("fac_d");
    expect(f?.departures).toEqual([]);
    expect(f?.arrivals.map((g) => g.patients.map((p) => p.tripId))).toEqual([["A", "B"], ["D"], ["C"]]);
    expect(f?.arrivals[0]).toMatchObject({ vehicle: taxi1, minute: 440, otherCoPassengers: 0 });
    expect(f?.arrivals[0]?.patients[0]).toEqual({
      tripId: "A",
      patientName: "DUPONT Marie",
      plannedMinute: 440,
      referenceMinute: 450,
      sharingRefused: false,
    });
    // C shares the vehicle with X, who goes elsewhere.
    expect(f?.arrivals[2]?.otherCoPassengers).toBe(1);
  });

  it("joins trips of the same vehicle reaching the facility within a few minutes", () => {
    const [f] = groupSharedTransports([
      trip({ id: "A", plannedDropoffMinute: 440 }),
      trip({ id: "B", plannedDropoffMinute: 448 }),
      trip({ id: "C", plannedDropoffMinute: 470 }),
    ]);
    expect(f?.arrivals.map((g) => g.patients.map((p) => p.tripId))).toEqual([["A", "B"], ["C"]]);
  });

  it("separates arrivals from departures and uses the pickup time and end of session for departures", () => {
    const [f] = groupSharedTransports([
      trip({ id: "R1", direction: "RETURN", plannedPickupMinute: 700, readyMinute: 690, coPassengerIds: ["R2"] }),
      trip({ id: "R2", direction: "RETURN", plannedPickupMinute: 705, readyMinute: 700, coPassengerIds: ["R1"], routeValidated: false }),
      trip({ id: "O1", plannedDropoffMinute: 440, appointmentMinute: 450 }),
    ]);
    expect(f?.arrivals).toHaveLength(1);
    expect(f?.departures).toHaveLength(1);
    expect(f?.departures[0]).toMatchObject({ minute: 700, routeValidated: false });
    expect(f?.departures[0]?.patients.map((p) => [p.plannedMinute, p.referenceMinute])).toEqual([
      [700, 690],
      [705, 700],
    ]);
  });

  it("sorts facilities by name and skips trips without facility", () => {
    const facilities = groupSharedTransports([
      trip({ id: "A", facility: dialysis }),
      trip({ id: "B", facility: chu, vehicle: vsl2 }),
      trip({ id: "C", facility: null }),
    ]);
    expect(facilities.map((f) => f.facility.name)).toEqual(["Centre de dialyse Saint-Jean", "CHU de la Timone"]);
    expect(countPatients(facilities)).toEqual({ arrivals: 2, departures: 0, refused: 0 });
  });

  it("never merges trips without a vehicle", () => {
    const [f] = groupSharedTransports([
      trip({ id: "A", vehicle: null, plannedDropoffMinute: 440 }),
      trip({ id: "B", vehicle: null, plannedDropoffMinute: 440 }),
    ]);
    expect(f?.arrivals).toHaveLength(2);
  });

  it("lists only trips with a co-passenger on board according to the stops", () => {
    // B's co-passenger was cancelled: B now travels alone, whatever its stored flag says.
    const facilities = groupSharedTransports([
      trip({ id: "A", plannedDropoffMinute: 440, coPassengerIds: ["C"] }),
      trip({ id: "B", vehicle: vsl2, plannedDropoffMinute: 450, coPassengerIds: [] }),
      trip({ id: "C", facility: chu, plannedDropoffMinute: 420, coPassengerIds: ["A"] }),
    ]);
    expect(facilities.map((f) => [f.facility.id, f.arrivals.map((g) => g.patients.map((p) => p.tripId))])).toEqual([
      ["fac_d", [["A"]]],
      ["fac_c", [["C"]]],
    ]);
    expect(groupSharedTransports([trip({ id: "B", coPassengerIds: [] })])).toEqual([]);
  });

  it("flags and counts patients listed although they refused sharing", () => {
    const facilities = groupSharedTransports([
      trip({ id: "A", plannedDropoffMinute: 440, coPassengerIds: ["B"], sharingRefused: true }),
      trip({ id: "B", plannedDropoffMinute: 445, coPassengerIds: ["A"] }),
    ]);
    expect(facilities[0]?.arrivals[0]?.patients.map((p) => [p.tripId, p.sharingRefused])).toEqual([
      ["A", true],
      ["B", false],
    ]);
    expect(countPatients(facilities)).toEqual({ arrivals: 2, departures: 0, refused: 1 });
  });
});

describe("facility sheet", () => {
  it("reads the facility filter and ignores odd values", () => {
    expect(parseFacilityFilter("clx0abc123")).toBe("clx0abc123");
    expect(parseFacilityFilter([" fac_d ", "other"])).toBe("fac_d");
    expect(parseFacilityFilter(undefined)).toBeNull();
    expect(parseFacilityFilter("")).toBeNull();
    expect(parseFacilityFilter("a'; DROP")).toBeNull();
    expect(parseFacilityFilter("x".repeat(65))).toBeNull();
  });

  it("builds the page links", () => {
    expect(sharedArrivalsHref("2026-11-03")).toBe("/arrivees-partagees?date=2026-11-03");
    expect(sharedArrivalsHref("2026-11-03", "fac_d")).toBe("/arrivees-partagees?date=2026-11-03&etablissement=fac_d");
  });
});
