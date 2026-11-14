import { describe, expect, it } from "vitest";
import { planKeyOf, roadmapStatesOf } from "./live-load";
import { roadmapSnapshot } from "./roadmap-version";

type Routes = Parameters<typeof planKeyOf>[0];
type Trips = Parameters<typeof planKeyOf>[1];

const routes = (startMinute = 480, completedAt: Date | null = null): Routes => [
  {
    id: "r1",
    vehicleId: "v1",
    status: "VALIDATED",
    driverId: "d1",
    crewMateId: null,
    startMinute: 450,
    endMinute: 600,
    breakStartMinute: null,
    breakEndMinute: null,
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

describe("roadmapStatesOf", () => {
  const time = new Date("2026-11-16T09:00:00.000Z");
  const plain = routes().map((r) => ({ vehicleId: r.vehicleId, stops: r.stops }));
  const current = roadmapSnapshot(plain[0]!.stops, () => false);

  it("says when the crew opened its roadmap, and when the stored one has changed since", () => {
    const opened = [{ vehicleId: "v1", version: 1, fingerprint: current.fingerprint, stops: current.stops, publishedAt: time, seenAt: time, seenBy: { name: "Julien Marchetti" } }];
    expect(roadmapStatesOf({ isoDate: "2026-11-16", routes: plain, cancelled: () => false, versions: opened, now: time })).toEqual({
      v1: { text: "Ouverte à 10:00 par Julien Marchetti", tone: "ok", pendingSince: null },
    });
    const moved = routes(500).map((r) => ({ vehicleId: r.vehicleId, stops: r.stops }));
    expect(roadmapStatesOf({ isoDate: "2026-11-16", routes: moved, cancelled: () => false, versions: opened, now: time }).v1?.tone).toBe("pending");
  });

  it("says a roadmap not opened yet", () => {
    expect(roadmapStatesOf({ isoDate: "2026-11-16", routes: plain, cancelled: () => false, versions: [], now: time }).v1?.text).toBe(
      "Feuille de route pas encore ouverte sur le téléphone",
    );
  });
});
