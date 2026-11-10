import { describe, expect, it } from "vitest";
import {
  coPassengersFromStops,
  coursesHref,
  EMPTY_FILTERS,
  filterTrips,
  formatInstant,
  generationMessage,
  hasActiveFilters,
  normalizeSearch,
  pairedReturns,
  parseTripFilters,
  patientDisplayName,
  plural,
  shortPatientName,
  sortTrips,
  summarizeTrips,
} from "./trip-list";

type T = Parameters<typeof summarizeTrips>[0][number] &
  Parameters<typeof sortTrips>[0][number] &
  Omit<Parameters<typeof filterTrips>[0][number], "status" | "direction" | "sharingStatus" | "shared" | "patient">;

function trip(overrides: Partial<T> & { id: string }): T {
  return {
    direction: "OUTBOUND",
    appointmentMinute: 480,
    readyMinute: null,
    status: "PLANNED",
    routeId: null,
    shared: false,
    sharingStatus: "NOT_PROPOSED",
    sharingAllowed: true,
    patient: { firstName: "Marie", lastName: "Martin" },
    ...overrides,
  };
}

describe("parseTripFilters", () => {
  it("keeps known values and ignores the rest", () => {
    expect(parseTripFilters({ statut: "CANCELLED", sens: "RETURN", partage: "SHARED", q: "  dupont " })).toEqual({
      ...EMPTY_FILTERS,
      status: "CANCELLED",
      direction: "RETURN",
      sharing: "SHARED",
      q: "dupont",
    });
    expect(parseTripFilters({ statut: "RETURN_TO_CHECK" }).status).toBe("RETURN_TO_CHECK");
    expect(parseTripFilters({ statut: "DROP TABLE", sens: ["OUTBOUND", "RETURN"], partage: "nope" })).toEqual({
      ...EMPTY_FILTERS,
      direction: "OUTBOUND",
    });
    expect(
      parseTripFilters({ etablissement: "fac_1", vehicule: "aucun", depot: "dep_gap", payeur: "PRIVATE", origine: "ponctuelle" }),
    ).toEqual({ ...EMPTY_FILTERS, facility: "fac_1", vehicle: "aucun", depot: "dep_gap", payer: "PRIVATE", origin: "ponctuelle" });
    expect(parseTripFilters({ payeur: "MUTUELLE", origine: "x", depot: "a b" })).toEqual(EMPTY_FILTERS);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, depot: "d" })).toBe(true);
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, q: "x" })).toBe(true);
    // A patient by id (the planning's links), never anything else.
    expect(parseTripFilters({ patient: "cm9patient_1" }).patient).toBe("cm9patient_1");
    expect(parseTripFilters({ patient: "Hélène Dupré" }).patient).toBeNull();
    expect(hasActiveFilters({ ...EMPTY_FILTERS, patient: "p1" })).toBe(true);
  });
});

describe("filterTrips", () => {
  const trips = [
    trip({ id: "a", patient: { firstName: "Hélène", lastName: "Dupré" } }),
    trip({ id: "b", status: "CANCELLED", direction: "RETURN", sharingStatus: "REFUSED" }),
    trip({ id: "c", status: "ASSIGNED", shared: true, sharingStatus: "ACCEPTED" }),
  ];
  const ids = (list: T[]) => list.map((t) => t.id);

  it("filters by status, with ACTIVE hiding cancelled trips", () => {
    expect(ids(filterTrips(trips, { ...EMPTY_FILTERS, status: "CANCELLED" }))).toEqual(["b"]);
    expect(ids(filterTrips(trips, { ...EMPTY_FILTERS, status: "ACTIVE" }))).toEqual(["a", "c"]);
  });

  it("keeps only the return trips to check after an outbound absence", () => {
    const withFlag = [...trips, trip({ id: "r", direction: "RETURN", outboundNoShow: true })];
    expect(ids(filterTrips(withFlag, { ...EMPTY_FILTERS, status: "RETURN_TO_CHECK" }))).toEqual(["r"]);
    expect(ids(filterTrips(trips, { ...EMPTY_FILTERS, status: "RETURN_TO_CHECK" }))).toEqual([]);
  });

  it("filters by direction and sharing", () => {
    expect(ids(filterTrips(trips, { ...EMPTY_FILTERS, direction: "RETURN" }))).toEqual(["b"]);
    expect(ids(filterTrips(trips, { ...EMPTY_FILTERS, sharing: "SHARED" }))).toEqual(["c"]);
    expect(ids(filterTrips(trips, { ...EMPTY_FILTERS, sharing: "REFUSED" }))).toEqual(["b"]);
  });

  it("filters on one patient by id", () => {
    const mine = [trip({ id: "a", patientId: "p1" }), trip({ id: "b", patientId: "p2" }), trip({ id: "c", patientId: "p1", direction: "RETURN" })];
    expect(ids(filterTrips(mine, { ...EMPTY_FILTERS, patient: "p1" }))).toEqual(["a", "c"]);
    expect(ids(filterTrips(mine, { ...EMPTY_FILTERS, patient: "p1", direction: "RETURN" }))).toEqual(["c"]);
  });

  it("filters by facility (or a free address), vehicle, unassigned, depot, payer and origin", () => {
    const day = [
      trip({ id: "a", facilityId: "f1", routeId: "r1", route: { vehicle: { id: "v1", depotId: "gap" } }, recurrenceId: "rec", payer: "CPAM" }),
      trip({ id: "b", facilityId: null, routeId: null, payer: "PRIVATE" }),
      trip({ id: "c", facilityId: "f2", routeId: "r2", route: { vehicle: { id: "v2", depotId: "aix" } }, recurrenceId: "rec", payer: "CPAM" }),
      trip({ id: "x", facilityId: "f1", routeId: null, status: "CANCELLED", payer: "CPAM" }),
    ];
    expect(ids(filterTrips(day, { ...EMPTY_FILTERS, facility: "f1" }))).toEqual(["a", "x"]);
    expect(ids(filterTrips(day, { ...EMPTY_FILTERS, facility: "libre" }))).toEqual(["b"]);
    expect(ids(filterTrips(day, { ...EMPTY_FILTERS, vehicle: "v2" }))).toEqual(["c"]);
    // Unassigned: still to place, a cancelled trip is not.
    expect(ids(filterTrips(day, { ...EMPTY_FILTERS, vehicle: "aucun" }))).toEqual(["b"]);
    expect(ids(filterTrips(day, { ...EMPTY_FILTERS, depot: "gap" }))).toEqual(["a"]);
    expect(ids(filterTrips(day, { ...EMPTY_FILTERS, payer: "PRIVATE" }))).toEqual(["b"]);
    expect(ids(filterTrips(day, { ...EMPTY_FILTERS, origin: "reguliere" }))).toEqual(["a", "c"]);
    expect(ids(filterTrips(day, { ...EMPTY_FILTERS, origin: "ponctuelle" }))).toEqual(["b", "x"]);
  });

  it("searches the facility and the addresses too", () => {
    const day = [
      trip({ id: "a", facility: { name: "Clinique du Parc" }, pickupAddress: "1 rue X, 05000 Gap", dropoffAddress: "Clinique, Gap" }),
      trip({ id: "b", facility: { name: "Centre de dialyse" }, pickupAddress: "2 rue Y, 13006 Marseille", dropoffAddress: "Aix" }),
    ];
    expect(ids(filterTrips(day, { ...EMPTY_FILTERS, q: "clinique gap" }))).toEqual(["a"]);
    expect(ids(filterTrips(day, { ...EMPTY_FILTERS, q: "marseille" }))).toEqual(["b"]);
    expect(ids(filterTrips(day, { ...EMPTY_FILTERS, q: "martin dialyse" }))).toEqual(["b"]);
  });

  it("searches patient names without case or accents, in both orders", () => {
    expect(ids(filterTrips(trips, { ...EMPTY_FILTERS, q: "helene dup" }))).toEqual(["a"]);
    expect(ids(filterTrips(trips, { ...EMPTY_FILTERS, q: "DUPRE HÉL" }))).toEqual(["a"]);
    expect(ids(filterTrips(trips, { ...EMPTY_FILTERS, q: "martin" }))).toEqual(["b", "c"]);
    expect(normalizeSearch("  Éloïse   Béranger ")).toBe("eloise beranger");
  });
});

describe("sortTrips", () => {
  it("sorts by RDV for outbound legs and end of session for return legs, missing times last", () => {
    const sorted = sortTrips([
      trip({ id: "ret", direction: "RETURN", appointmentMinute: null, readyMinute: 600 }),
      trip({ id: "none", direction: "RETURN", appointmentMinute: 300, readyMinute: null }),
      trip({ id: "out", appointmentMinute: 450 }),
      trip({ id: "out2", appointmentMinute: 700 }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["out", "ret", "out2", "none"]);
  });

  it("breaks ties by patient name, then outbound first", () => {
    const sorted = sortTrips([
      trip({ id: "z", patient: { firstName: "A", lastName: "Zola" } }),
      trip({ id: "r", direction: "RETURN", appointmentMinute: null, readyMinute: 480, patient: { firstName: "A", lastName: "Abel" } }),
      trip({ id: "o", patient: { firstName: "A", lastName: "Abel" } }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["o", "r", "z"]);
  });
});

describe("summarizeTrips", () => {
  it("counts the day, cancelled trips apart", () => {
    const summary = summarizeTrips([
      trip({ id: "1", routeId: "r1", shared: true, sharingStatus: "ACCEPTED" }),
      trip({ id: "2", direction: "RETURN", sharingStatus: "PROPOSED" }),
      trip({ id: "3", sharingStatus: "REFUSED" }),
      trip({ id: "4", status: "CANCELLED", routeId: null, sharingStatus: "REFUSED" }),
      trip({ id: "5", sharingAllowed: false, sharingStatus: "NOT_ELIGIBLE" }),
    ]);
    expect(summary).toEqual({
      total: 4,
      outbound: 3,
      return: 1,
      assigned: 1,
      unassigned: 3,
      shared: 1,
      sharingAccepted: 1,
      sharingRefused: 1,
      sharingPending: 1,
      sharingConflicts: 0,
      returnsToCheck: 0,
      cancelled: 1,
    });
  });

  it("counts the return trips to check after an outbound absence", () => {
    const summary = summarizeTrips([
      trip({ id: "out", status: "NO_SHOW" }),
      trip({ id: "ret", direction: "RETURN", outboundNoShow: true }),
      trip({ id: "other", direction: "RETURN" }),
    ]);
    expect(summary.returnsToCheck).toBe(1);
  });

  it("counts refused trips still shared in the plan", () => {
    const summary = summarizeTrips([
      trip({ id: "1", status: "ASSIGNED", routeId: "r1", shared: true, sharingStatus: "REFUSED" }),
      trip({ id: "2", status: "ASSIGNED", routeId: "r1", shared: true, sharingStatus: "PROPOSED" }),
      trip({ id: "3", status: "ASSIGNED", routeId: "r2", shared: false, sharingStatus: "REFUSED" }),
    ]);
    expect(summary.sharingRefused).toBe(2);
    expect(summary.sharingConflicts).toBe(1);
  });
});

describe("coursesHref", () => {
  it("keeps only the filters in use", () => {
    expect(coursesHref("2026-11-03")).toBe("/courses?date=2026-11-03");
    expect(coursesHref("2026-11-03", { ...EMPTY_FILTERS, status: "ACTIVE", sharing: "REFUSED", q: "Le Gall" })).toBe(
      "/courses?date=2026-11-03&statut=ACTIVE&partage=REFUSED&q=Le+Gall",
    );
    expect(coursesHref("2026-11-03", { ...EMPTY_FILTERS, direction: "RETURN", patient: "p1" })).toBe("/courses?date=2026-11-03&sens=RETURN&patient=p1");
    expect(coursesHref("2026-11-03", { ...EMPTY_FILTERS, vehicle: "aucun", depot: "d1" })).toBe("/courses?date=2026-11-03&vehicule=aucun&depot=d1");
  });
});

describe("coPassengersFromStops", () => {
  it("links trips on board at the same time, route by route", () => {
    const map = coPassengersFromStops([
      // Route 1: A picked up, B picked up, A dropped, C picked up, B dropped, C dropped.
      { routeId: "r1", tripId: "A", kind: "PICKUP", sequence: 1 },
      { routeId: "r1", tripId: "B", kind: "PICKUP", sequence: 2 },
      { routeId: "r1", tripId: "A", kind: "DROPOFF", sequence: 3 },
      { routeId: "r1", tripId: "C", kind: "PICKUP", sequence: 4 },
      { routeId: "r1", tripId: "C", kind: "DROPOFF", sequence: 6 },
      { routeId: "r1", tripId: "B", kind: "DROPOFF", sequence: 5 },
      // Route 2: D then E, never together.
      { routeId: "r2", tripId: "D", kind: "PICKUP", sequence: 1 },
      { routeId: "r2", tripId: "D", kind: "DROPOFF", sequence: 2 },
      { routeId: "r2", tripId: "E", kind: "PICKUP", sequence: 3 },
      { routeId: "r2", tripId: "E", kind: "DROPOFF", sequence: 4 },
    ]);
    expect(map.get("A")).toEqual(["B"]);
    expect(map.get("B")?.sort()).toEqual(["A", "C"]);
    expect(map.get("C")).toEqual(["B"]);
    expect(map.has("D")).toBe(false);
    expect(map.has("E")).toBe(false);
  });
});

describe("formatting", () => {
  it("formats names, plurals and instants", () => {
    expect(shortPatientName({ firstName: "marie", lastName: "Dupont" })).toBe("Dupont M.");
    expect(patientDisplayName({ firstName: "Marie", lastName: "Dupont" })).toBe("DUPONT Marie");
    expect(plural(0, "course", "courses")).toBe("0 course");
    expect(plural(2, "course", "courses")).toBe("2 courses");
    expect(formatInstant(new Date("2026-11-02T13:05:00Z"))).toBe("02/11/2026 14:05");
    expect(formatInstant(null)).toBeNull();
  });

  it("reports the trips created and brought back over the generated days", () => {
    expect(generationMessage({ created: 12, revived: 0 }, "2026-11-03", "2026-11-08")).toBe(
      "Du 03/11/2026 au 08/11/2026 : 12 courses créées.",
    );
    expect(generationMessage({ created: 1, revived: 2 }, "2026-11-03", "2026-11-08")).toBe(
      "Du 03/11/2026 au 08/11/2026 : 1 course créée, 2 courses annulées automatiquement rétablies.",
    );
    expect(generationMessage({ created: 0, revived: 0 }, "2026-11-08", "2026-11-08")).toBe(
      "Le 08/11/2026 : toutes les courses régulières existent déjà.",
    );
  });
});

describe("pairedReturns", () => {
  const leg = (id: string, direction: "OUTBOUND" | "RETURN", overrides: Record<string, unknown> = {}) => ({
    id,
    direction,
    status: "PLANNED" as const,
    patientId: "p1",
    recurrenceId: "rec1",
    facilityId: "f1",
    readyMinute: direction === "RETURN" ? 690 : null,
    routeId: null as string | null,
    shared: false,
    ...overrides,
  });

  it("pairs an open outbound trip with the open return of the same care", () => {
    const pairs = pairedReturns([leg("a1", "OUTBOUND"), leg("r1", "RETURN"), leg("r2", "RETURN", { patientId: "p2" })]);
    expect(pairs).toEqual(new Map([["a1", { id: "r1", keyMinute: 690, inRoute: false, shared: false }]]));
    // In a route, shared: said in the confirmation of « Annuler la sélection ».
    expect(pairedReturns([leg("a1", "OUTBOUND"), leg("r1", "RETURN", { routeId: "route1", shared: true })]).get("a1")).toEqual({
      id: "r1",
      keyMinute: 690,
      inRoute: true,
      shared: true,
    });
  });

  it("offers nothing for a return already cancelled or started, nor for an outbound trip already cancelled", () => {
    expect(pairedReturns([leg("a1", "OUTBOUND"), leg("r1", "RETURN", { status: "CANCELLED" })]).size).toBe(0);
    expect(pairedReturns([leg("a1", "OUTBOUND"), leg("r1", "RETURN", { status: "PICKED_UP" })]).size).toBe(0);
    expect(pairedReturns([leg("a1", "OUTBOUND", { status: "CANCELLED" }), leg("r1", "RETURN")]).size).toBe(0);
    // Another care of the same patient (another recurrence): not the same episode.
    expect(pairedReturns([leg("a1", "OUTBOUND"), leg("r1", "RETURN", { recurrenceId: "rec2" })]).size).toBe(0);
  });
});
