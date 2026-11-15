import { describe, expect, it } from "vitest";
import { acknowledgeRoadmap, syncCrewRoadmaps } from "./roadmap-sync";

// A crew's phone checking its roadmap against an in-memory client: version 1 acknowledged by the first opening, a new
// version published (and dated) when the regulation changed the route, « J'ai vu » on the latest one, a new crew.
type Version = { serviceDate: Date; vehicleId: string; version: number; fingerprint: string; stops: unknown; publishedAt: Date; seenAt: Date | null; seenById: string | null; createdAt?: Date };
type Stop = { tripId: string; kind: "PICKUP" | "DROPOFF"; sequence: number; startMinute: number; trip: { status: string; direction?: string; readyMinute?: number | null } };

/** The accounts of the crew members (User.driverId). */
const DRIVER_OF: Record<string, string> = { u1: "d1", u2: "d2" };

function client(stops: Stop[], routeUpdatedAt: Date, tripUpdates: Record<string, Date> = {}) {
  const versions: Version[] = [];
  const route = { vehicleId: "v1", driverId: "d1", crewMateId: null as string | null, updatedAt: routeUpdatedAt, stops };
  return {
    versions,
    setStops(next: Stop[]) {
      route.stops = next;
    },
    setDriver(driverId: string) {
      route.driverId = driverId;
    },
    route: {
      findMany: async () => [route],
      findFirst: async ({ where }: { where: { vehicleId: string } }) => (where.vehicleId === "v1" ? { id: "r1" } : null),
    },
    trip: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ updatedAt: tripUpdates[id] ?? new Date(0) })) },
    routeVersion: {
      findMany: async () =>
        [...versions].sort((a, b) => a.version - b.version).map((v) => ({ ...v, seenBy: v.seenById ? { driverId: DRIVER_OF[v.seenById] ?? null } : null })),
      findFirst: async ({ where }: { where: { version: number } }) => versions.find((v) => v.version === where.version) ?? null,
      create: async ({ data }: { data: Omit<Version, "seenAt" | "seenById"> & Partial<Pick<Version, "seenAt" | "seenById">> }) => {
        versions.push({ ...data, seenAt: data.seenAt ?? null, seenById: data.seenById ?? null });
        return data;
      },
      updateMany: async ({ where, data }: { where: { version: number; seenAt?: null }; data: { seenAt: Date; seenById: string } }) => {
        const row = versions.find((v) => v.version === where.version && (where.seenAt === undefined || v.seenAt === null));
        if (row) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      },
    },
  };
}

const stop = (tripId: string, kind: "PICKUP" | "DROPOFF", sequence: number, startMinute: number, status = "ASSIGNED", readyMinute: number | null = null): Stop => ({
  tripId,
  kind,
  sequence,
  startMinute,
  trip: { status, direction: readyMinute !== null ? "RETURN" : "OUTBOUND", readyMinute },
});
const at = (hhmm: string) => new Date(`2026-11-16T${hhmm}:00+01:00`);
const ARGS = { isoDate: "2026-11-16", driverId: "d1", userId: "u1" };

describe("syncCrewRoadmaps", () => {
  it("publishes version 1 at the first opening, acknowledged by it: nothing to tell", async () => {
    const fake = client([stop("a", "PICKUP", 1, 480), stop("a", "DROPOFF", 2, 510)], at("06:00"));
    const [state] = await syncCrewRoadmaps(fake as never, { ...ARGS, now: at("07:00") });
    expect(state).toMatchObject({ vehicleId: "v1", version: 1, pending: null });
    expect(fake.versions[0]).toMatchObject({ version: 1, seenAt: at("07:00"), seenById: "u1", publishedAt: at("07:00") });
    // Checked again without change: no new version.
    await syncCrewRoadmaps(fake as never, { ...ARGS, now: at("07:02") });
    expect(fake.versions).toHaveLength(1);
  });

  it("publishes a change dated by the trips it concerns, tells it until « J'ai vu »", async () => {
    const fake = client([stop("a", "PICKUP", 1, 480), stop("a", "DROPOFF", 2, 510), stop("b", "PICKUP", 3, 600), stop("b", "DROPOFF", 4, 630)], at("06:00"), { b: at("09:12") });
    await syncCrewRoadmaps(fake as never, { ...ARGS, now: at("07:00") });
    fake.setStops([stop("a", "PICKUP", 1, 480), stop("a", "DROPOFF", 2, 510)]);
    const [state] = await syncCrewRoadmaps(fake as never, { ...ARGS, now: at("09:20") });
    expect(state?.version).toBe(2);
    expect(state?.pending).toMatchObject({ changedAt: at("09:12").toISOString(), text: "1\u00a0course retirée", removed: [{ tripId: "b", kind: "PICKUP", minute: 600 }] });
    expect(fake.versions[1]).toMatchObject({ version: 2, seenAt: null, publishedAt: at("09:12") });

    expect(await acknowledgeRoadmap(fake as never, { ...ARGS, vehicleId: "v1", version: 2, now: at("09:25") })).toEqual({ routeId: "r1" });
    const [after] = await syncCrewRoadmaps(fake as never, { ...ARGS, now: at("09:26") });
    expect(after?.pending).toBeNull();
    expect(fake.versions[1]).toMatchObject({ seenAt: at("09:25"), seenById: "u1" });
  });

  it("tells the crew doing a return that its end of session moved", async () => {
    const back = (readyMinute: number) => [stop("b", "PICKUP", 1, 840, "ASSIGNED", readyMinute), stop("b", "DROPOFF", 2, 870, "ASSIGNED", readyMinute)];
    const fake = client(back(840), at("06:00"), { b: at("10:47") });
    const [first] = await syncCrewRoadmaps(fake as never, { ...ARGS, now: at("07:00") });
    // « Patient prêt à 14:15 » signalled by the crew at the drop-off: the same planned time, another end of session.
    fake.setStops(back(855));
    const [state] = await syncCrewRoadmaps(fake as never, { ...ARGS, now: at("10:50") });
    expect(state?.fingerprint).not.toBe(first?.fingerprint);
    expect(state?.pending).toMatchObject({ text: "1\u00a0course décalée", highlight: ["b/PICKUP"] });
  });

  it("counts for a new crew only what it saw: its first opening, not the previous crew's « J'ai vu »", async () => {
    const fake = client([stop("a", "PICKUP", 1, 480), stop("a", "DROPOFF", 2, 510)], at("06:00"), { a: at("09:12") });
    await syncCrewRoadmaps(fake as never, { ...ARGS, now: at("07:00") });
    fake.setStops([stop("a", "PICKUP", 1, 500), stop("a", "DROPOFF", 2, 530)]);
    await syncCrewRoadmaps(fake as never, { ...ARGS, now: at("09:20") });
    // « Changer l'équipage »: d2 takes the vehicle, and opens a roadmap it never saw.
    fake.setDriver("d2");
    const [state] = await syncCrewRoadmaps(fake as never, { isoDate: "2026-11-16", driverId: "d2", userId: "u2", now: at("09:30") });
    expect(state?.pending).toBeNull();
    expect(fake.versions.at(-1)).toMatchObject({ version: 2, seenAt: at("09:30"), seenById: "u2" });
  });

  it("acknowledges nothing on another crew's vehicle or an unknown version", async () => {
    const fake = client([stop("a", "PICKUP", 1, 480)], at("06:00"));
    await syncCrewRoadmaps(fake as never, { ...ARGS, now: at("07:00") });
    expect(await acknowledgeRoadmap(fake as never, { ...ARGS, vehicleId: "v2", version: 1, now: at("07:05") })).toBeNull();
    expect(await acknowledgeRoadmap(fake as never, { ...ARGS, vehicleId: "v1", version: 9, now: at("07:05") })).toBeNull();
  });
});
