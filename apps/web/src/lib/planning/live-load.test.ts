import { describe, expect, it } from "vitest";
import { todayIso } from "@/lib/time";
import { livePlanToken, planKeyOf, roadmapStatesOf, shownPlanHolds } from "./live-load";
import { roadmapSnapshot } from "./roadmap-version";

type Routes = Parameters<typeof planKeyOf>[0];
type Trips = Parameters<typeof planKeyOf>[1];

const routes = (startMinute = 480, completedAt: Date | null = null, driverId = "d1"): Routes => [
  {
    id: "r1",
    vehicleId: "v1",
    status: "VALIDATED",
    driverId,
    crewMateId: null,
    startMinute: 450,
    endMinute: 600,
    breakStartMinute: null,
    breakEndMinute: null,
    updatedAt: new Date("2026-11-16T09:47:00.000Z"),
    stops: [
      { id: "s1", tripId: "a", kind: "PICKUP", sequence: 1, startMinute, completedAt },
      { id: "s2", tripId: "a", kind: "DROPOFF", sequence: 2, startMinute: 510, completedAt: null },
    ],
  },
];
const trips = (status: Trips[number]["status"] = "ASSIGNED", readyMinute: number | null = null): Trips => [
  {
    id: "a",
    status,
    direction: "OUTBOUND",
    readyMinute,
    updatedAt: new Date("2026-11-16T06:00:00.000Z"),
    appointmentMinute: 540,
    routeId: "r1",
    lockedVehicleId: null,
    patientId: "p1",
    recurrenceId: null,
    facilityId: "f1",
    payer: "CPAM",
    sharingStatus: "NOT_PROPOSED",
    pickupAddress: "x",
    dropoffAddress: "y",
    notes: null,
  },
];

describe("planKeyOf", () => {
  it("does not move with what the field records (statuses, end of session)", () => {
    const key = planKeyOf(routes(), trips());
    expect(planKeyOf(routes(480, new Date()), trips("PICKED_UP", 700))).toBe(key);
  });

  it("moves when the plan itself changes: a stop's time, a cancellation, a note", () => {
    const key = planKeyOf(routes(), trips());
    expect(planKeyOf(routes(490), trips())).not.toBe(key);
    expect(planKeyOf(routes(), trips("CANCELLED"))).not.toBe(key);
    expect(planKeyOf(routes(), [{ ...trips()[0]!, notes: "Code 1234" }])).not.toBe(key);
  });
});

describe("shownPlanHolds", () => {
  const client = (r: Routes, t: Trips, version = "v-token") => ({
    route: { findMany: async () => r },
    trip: { findMany: async () => t },
    $queryRaw: async () => [{ routes: 1, routesAt: null, stops: 2, trips: 1, tripsAt: null, version }],
  });
  const today = todayIso();

  it("keeps the page of today valid while the crews record statuses, not once the plan changed", async () => {
    const shown = livePlanToken(planKeyOf(routes(), trips()));
    expect(await shownPlanHolds(client(routes(480, new Date()), trips("PICKED_UP", 700)) as never, today, shown)).toBe(true);
    expect(await shownPlanHolds(client(routes(495), trips()) as never, today, shown)).toBe(false);
    // The key of today is never accepted for another day.
    expect(await shownPlanHolds(client(routes(), trips()) as never, "2020-01-01", shown)).toBe(false);
    expect(await shownPlanHolds(client(routes(), trips()) as never, today, 42)).toBe(false);
  });
});

describe("roadmapStatesOf", () => {
  const now = new Date("2026-11-16T10:00:00.000Z");
  const opened = new Date("2026-11-16T06:05:00.000Z");
  const plain = (startMinute = 480, driverId = "d1") => routes(startMinute, null, driverId);
  const tripMap = new Map(trips().map((t) => [t.id, t]));
  const snapshot = (startMinute = 480) => roadmapSnapshot(plain(startMinute)[0]!.stops, () => false);
  const version = (n: number, startMinute: number, publishedAt: Date, seenAt: Date | null) => ({
    vehicleId: "v1",
    version: n,
    fingerprint: snapshot(startMinute).fingerprint,
    stops: snapshot(startMinute).stops,
    publishedAt,
    seenAt,
    seenBy: seenAt ? { name: "Julien Marchetti", driverId: "d1" } : null,
  });
  const states = (r: Routes, versions: ReturnType<typeof version>[]) => roadmapStatesOf({ isoDate: "2026-11-16", routes: r, trips: tripMap, versions, now });

  it("says when the crew opened its roadmap, naming it", () => {
    expect(states(plain(), [version(1, 480, opened, opened)])).toEqual({
      v1: { text: "Feuille de route ouverte à 07:05 par Julien Marchetti", tone: "ok", pendingSince: null },
    });
  });

  it("lists a change the phone has not received yet, dated by the latest update of what it concerns", () => {
    // Moved by 20 min while the phone was in the pocket: no version published since the opening.
    expect(states(plain(500), [version(1, 480, opened, opened)]).v1).toEqual({
      text: "Feuille de route modifiée à 10:47 (1 course décalée), pas encore reçue sur le téléphone",
      tone: "pending",
      pendingSince: "2026-11-16T09:47:00.000Z",
    });
    // A move under 5 min is not worth telling: nothing pending.
    expect(states(plain(483), [version(1, 480, opened, opened)]).v1).toMatchObject({ tone: "ok", pendingSince: null });
  });

  it("lists a change received and not seen, dated when it was published", () => {
    const published = new Date("2026-11-16T08:12:00.000Z");
    expect(states(plain(500), [version(1, 480, opened, opened), version(2, 500, published, null)]).v1).toEqual({
      text: "Feuille de route modifiée à 09:12 (1 course décalée), pas encore vue",
      tone: "pending",
      pendingSince: published.toISOString(),
    });
  });

  it("says a roadmap not opened yet, also by a crew put on the vehicle after the previous one saw it", () => {
    expect(states(plain(), []).v1?.text).toBe("Feuille de route pas encore ouverte sur le téléphone");
    expect(states(plain(480, "d2"), [version(1, 480, opened, opened)]).v1).toEqual({
      text: "Feuille de route pas encore ouverte sur le téléphone",
      tone: "info",
      pendingSince: null,
    });
  });
});
