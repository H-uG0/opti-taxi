import { describe, expect, it } from "vitest";
import {
  changeCountsText,
  changedTripIds,
  hasChanges,
  publicationTime,
  removedText,
  roadmapChanges,
  roadmapPending,
  roadmapSnapshot,
  roadmapStanding,
  roadmapStateText,
  seenByCrew,
  storedStops,
  type RoadmapStop,
  type StoredVersion,
} from "./roadmap-version";

const P = (t: string, m: number, c?: 1): RoadmapStop => ({ t, k: "P", m, ...(c ? { c } : {}) });
const D = (t: string, m: number, c?: 1): RoadmapStop => ({ t, k: "D", m, ...(c ? { c } : {}) });

describe("roadmapSnapshot", () => {
  const stops = [
    { tripId: "b", kind: "DROPOFF" as const, sequence: 4, startMinute: 600 },
    { tripId: "a", kind: "PICKUP" as const, sequence: 1, startMinute: 480 },
    { tripId: "a", kind: "DROPOFF" as const, sequence: 2, startMinute: 510 },
    { tripId: "b", kind: "PICKUP" as const, sequence: 3, startMinute: 570 },
  ];

  it("lists the stops in route order with their planned minute, the cancelled trips marked", () => {
    const snap = roadmapSnapshot(stops, (id) => id === "b");
    expect(snap.stops).toEqual([P("a", 480), D("a", 510), P("b", 570, 1), D("b", 600, 1)]);
  });

  it("gives the same fingerprint to the same roadmap and another one to any change", () => {
    const a = roadmapSnapshot(stops, () => false);
    expect(roadmapSnapshot([...stops].reverse(), () => false).fingerprint).toBe(a.fingerprint);
    expect(roadmapSnapshot(stops.map((s) => (s.sequence === 3 ? { ...s, startMinute: 571 } : s)), () => false).fingerprint).not.toBe(a.fingerprint);
    expect(roadmapSnapshot(stops, (id) => id === "a").fingerprint).not.toBe(a.fingerprint);
  });

  it("keeps the end of session of a return on its pickup: a new end of session redraws the roadmap", () => {
    const ready = (minute: number) => (id: string) => (id === "b" ? minute : null);
    const snap = roadmapSnapshot(stops, () => false, ready(840));
    expect(snap.stops).toEqual([P("a", 480), D("a", 510), { ...P("b", 570), r: 840 }, D("b", 600)]);
    expect(roadmapSnapshot(stops, () => false, ready(855)).fingerprint).not.toBe(snap.fingerprint);
    expect(roadmapSnapshot(stops, () => false, ready(840)).fingerprint).toBe(snap.fingerprint);
  });

  it("reads back the stops stored as JSON, dropping what it cannot read", () => {
    expect(storedStops([P("a", 1), { t: "x" }, null, D("a", 2, 1), { ...P("b", 3), r: 840 }])).toEqual([P("a", 1), D("a", 2, 1), { ...P("b", 3), r: 840 }]);
    expect(storedStops("nope")).toEqual([]);
  });
});

describe("roadmapChanges", () => {
  it("names the trips taken off, added and moved by 5 min or more, and the stops to highlight", () => {
    const before = [P("a", 480), D("a", 510), P("b", 570), D("b", 600), P("c", 700), D("c", 720)];
    const after = [P("a", 482), D("a", 512), P("b", 590), D("b", 620), P("d", 650), D("d", 680)];
    const changes = roadmapChanges(before, after);
    expect(changes.removed).toEqual([{ tripId: "c", kind: "PICKUP", minute: 700 }]);
    expect(changes.added).toEqual([{ tripId: "d", kind: "PICKUP", minute: 650 }]);
    expect(changes.shifted).toEqual([{ tripId: "b", kind: "PICKUP", from: 570, to: 590 }]);
    expect(changes.highlight).toEqual(["b/PICKUP", "b/DROPOFF", "d/PICKUP", "d/DROPOFF"]);
    expect(changeCountsText(changes)).toBe("1\u00a0course retirée, 1\u00a0ajoutée, 1\u00a0décalée");
  });

  it("counts a trip cancelled on the route as taken off", () => {
    const changes = roadmapChanges([P("a", 480), D("a", 510)], [P("a", 480, 1), D("a", 510, 1)]);
    expect(changes.removed).toHaveLength(1);
    expect(hasChanges(changes)).toBe(true);
  });

  it("finds nothing to tell for small moves", () => {
    expect(hasChanges(roadmapChanges([P("a", 480), D("a", 510)], [P("a", 483), D("a", 514)]))).toBe(false);
  });

  it("tells a return whose end of session moved by 5 min or more, even at the same planned time", () => {
    const changes = roadmapChanges([{ ...P("b", 840), r: 840 }, D("b", 870)], [{ ...P("b", 840), r: 855 }, D("b", 870)]);
    expect(changes.shifted).toEqual([{ tripId: "b", kind: "PICKUP", from: 840, to: 855 }]);
    expect(changes.highlight).toEqual(["b/PICKUP"]);
    // A version stored before the end of session was kept tells nothing about it.
    expect(hasChanges(roadmapChanges([P("b", 840), D("b", 870)], [{ ...P("b", 840), r: 855 }, D("b", 870)]))).toBe(false);
  });

  it("agrees the counts in number", () => {
    const two = { removed: [1, 2], added: [], shifted: [1, 2, 3] } as unknown as Parameters<typeof changeCountsText>[0];
    expect(changeCountsText(two)).toBe("2\u00a0courses retirées, 3\u00a0décalées");
    expect(changeCountsText({ removed: [], added: [], shifted: [{ tripId: "a", kind: "PICKUP", from: 1, to: 9 }] })).toBe("1\u00a0course décalée");
  });
});

const at = (hhmm: string) => new Date(`2026-11-16T${hhmm}:00+01:00`);
function version(n: number, stops: RoadmapStop[], published: string, seen: string | null = null, by: string | null = null): StoredVersion {
  return { version: n, fingerprint: `f${n}`, stops, publishedAt: at(published), seenAt: seen ? at(seen) : null, seenByName: by };
}

describe("roadmapStanding", () => {
  it("tells the changes since the version acknowledged, dated by the latest change worth telling", () => {
    const v1 = version(1, [P("a", 480), D("a", 510), P("b", 570), D("b", 600)], "06:00", "06:10", "Julien");
    const v2 = version(2, [P("a", 480), D("a", 510)], "09:12");
    // A re-timing of 2 min afterwards: not worth telling, the change stays dated 09:12.
    const v3 = version(3, [P("a", 482), D("a", 512)], "09:40");
    const standing = roadmapStanding([v3, v1, v2]);
    expect(standing?.seen?.version).toBe(1);
    expect(standing?.latest.version).toBe(3);
    expect(changeCountsText(standing!.changes)).toBe("1\u00a0course retirée");
    expect(standing?.changedAt).toEqual(at("09:12"));
  });

  it("has nothing pending once the latest version is acknowledged", () => {
    const standing = roadmapStanding([version(1, [P("a", 480)], "06:00", "06:10"), version(2, [], "09:12", "09:15", "Julien")]);
    expect(hasChanges(standing!.changes)).toBe(false);
    expect(standing?.changedAt).toBeNull();
  });

  it("compares with the first version when none was acknowledged", () => {
    const standing = roadmapStanding([version(1, [P("a", 480)], "06:00"), version(2, [P("a", 500)], "09:12")]);
    expect(standing?.seen).toBeNull();
    expect(standing?.changes.shifted).toHaveLength(1);
  });

  it("is null without any version", () => {
    expect(roadmapStanding([])).toBeNull();
  });
});

describe("seenByCrew", () => {
  it("counts only what the route's crew acknowledged", () => {
    const counts = seenByCrew({ driverId: "d1", crewMateId: "d2" });
    const seen = version(1, [], "06:00", "06:10");
    expect(counts({ ...seen, seenByDriverId: "d2" })).toBe(true);
    expect(counts({ ...seen, seenByDriverId: "d9" })).toBe(false);
    expect(counts({ ...seen, seenByDriverId: null })).toBe(false);
    const v1 = { ...version(1, [P("a", 480)], "06:00", "06:10"), seenByDriverId: "d9" };
    expect(roadmapStanding([v1], counts)?.seen).toBeNull();
  });
});

describe("roadmapPending and roadmapStateText", () => {
  const time = (d: Date) => d.toISOString().slice(11, 16);
  const snap = (stops: RoadmapStop[], fingerprint: string) => ({ stops, fingerprint });
  const v1 = version(1, [P("a", 480), P("b", 600)], "06:00", "06:10", "Julien");
  const undeliveredAt = () => at("10:47");

  it("says what the regulator needs: not yet opened, opened, up to date", () => {
    expect(roadmapStateText({ standing: null, pending: null, time })).toEqual({ text: "Feuille de route pas encore ouverte sur le téléphone", tone: "info" });
    expect(roadmapStateText({ standing: roadmapStanding([v1]), pending: null, time })).toEqual({ text: "Feuille de route ouverte à 05:10 par Julien", tone: "ok" });
    const v2seen = { ...version(2, [P("a", 480)], "09:12"), seenAt: at("09:15"), seenByName: "Julien" };
    expect(roadmapStateText({ standing: roadmapStanding([v1, v2seen]), pending: null, time })).toEqual({ text: "Feuille de route à jour, vue à 08:15 par Julien", tone: "ok" });
  });

  it("tells a change published and not seen, and one the phone has not received yet", () => {
    const v2 = version(2, [P("a", 480)], "09:12");
    const received = roadmapPending(roadmapStanding([v1, v2]), snap(v2.stops, "f2"), undeliveredAt);
    expect(received).toMatchObject({ changedAt: at("09:12"), received: true });
    expect(roadmapStateText({ standing: roadmapStanding([v1, v2]), pending: received, time }).text).toBe(
      "Feuille de route modifiée à 08:12 (1\u00a0course retirée), pas encore vue",
    );
    // Changed again since the phone's latest check: the whole change counted, dated by the latest one.
    const later = roadmapPending(roadmapStanding([v1, v2]), snap([P("a", 500)], "f3"), undeliveredAt);
    expect(later).toMatchObject({ changedAt: at("10:47"), received: false });
    expect(changeCountsText(later!.changes)).toBe("1\u00a0course retirée, 1\u00a0décalée");
    expect(roadmapStateText({ standing: roadmapStanding([v1, v2]), pending: later, time })).toEqual({
      text: "Feuille de route modifiée à 09:47 (1\u00a0course retirée, 1\u00a0décalée), pas encore reçue sur le téléphone",
      tone: "pending",
    });
  });

  it("has nothing pending for a move not worth telling, nor before the crew opened its roadmap", () => {
    expect(roadmapPending(roadmapStanding([v1]), snap([P("a", 482), P("b", 600)], "f1b"), undeliveredAt)).toBeNull();
    expect(roadmapPending(roadmapStanding([version(1, [P("a", 480)], "06:00")]), snap([], "f0"), undeliveredAt)).toBeNull();
    expect(roadmapPending(null, snap([], "f0"), undeliveredAt)).toBeNull();
  });
});

describe("publicationTime and changedTripIds", () => {
  it("dates a change by the latest update of what it concerns, within the previous version and the moment it was noticed", () => {
    expect(publicationTime({ previous: at("06:00"), noticedAt: at("10:00"), updates: [at("09:12"), at("08:00")] })).toEqual(at("09:12"));
    // An update older than the previous version (the change came from elsewhere): when it was noticed.
    expect(publicationTime({ previous: at("09:30"), noticedAt: at("10:00"), updates: [at("09:12")] })).toEqual(at("10:00"));
    expect(publicationTime({ previous: null, noticedAt: at("10:00"), updates: [at("11:00")] })).toEqual(at("10:00"));
  });

  it("lists the trips whose stops changed in any way", () => {
    expect(changedTripIds([P("a", 1), D("a", 2), P("b", 3)], [P("a", 1), D("a", 3), P("c", 4), P("b", 3, 1)]).sort()).toEqual(["a", "b", "c"]);
  });

  it("describes a stop taken off without naming the patient", () => {
    expect(removedText({ tripId: "c", kind: "PICKUP", minute: 630 })).toBe("prise en charge prévue à 10:30");
  });
});
