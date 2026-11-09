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

type T = Parameters<typeof summarizeTrips>[0][number] & Parameters<typeof sortTrips>[0][number];

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
      status: "CANCELLED",
      direction: "RETURN",
      sharing: "SHARED",
      q: "dupont",
    });
    expect(parseTripFilters({ statut: "RETURN_TO_CHECK" }).status).toBe("RETURN_TO_CHECK");
    expect(parseTripFilters({ statut: "DROP TABLE", sens: ["OUTBOUND", "RETURN"], partage: "nope" })).toEqual({
      status: null,
      direction: "OUTBOUND",
      sharing: null,
      q: "",
    });
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, q: "x" })).toBe(true);
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
    expect(coursesHref("2026-11-03", { status: "ACTIVE", direction: null, sharing: "REFUSED", q: "Le Gall" })).toBe(
      "/courses?date=2026-11-03&statut=ACTIVE&partage=REFUSED&q=Le+Gall",
    );
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
    ...overrides,
  });

  it("pairs an open outbound trip with the open return of the same care", () => {
    const pairs = pairedReturns([leg("a1", "OUTBOUND"), leg("r1", "RETURN"), leg("r2", "RETURN", { patientId: "p2" })]);
    expect(pairs).toEqual(new Map([["a1", { id: "r1", keyMinute: 690 }]]));
  });

  it("offers nothing for a return already cancelled or started, nor for an outbound trip already cancelled", () => {
    expect(pairedReturns([leg("a1", "OUTBOUND"), leg("r1", "RETURN", { status: "CANCELLED" })]).size).toBe(0);
    expect(pairedReturns([leg("a1", "OUTBOUND"), leg("r1", "RETURN", { status: "PICKED_UP" })]).size).toBe(0);
    expect(pairedReturns([leg("a1", "OUTBOUND", { status: "CANCELLED" }), leg("r1", "RETURN")]).size).toBe(0);
    // Another care of the same patient (another recurrence): not the same episode.
    expect(pairedReturns([leg("a1", "OUTBOUND"), leg("r1", "RETURN", { recurrenceId: "rec2" })]).size).toBe(0);
  });
});
