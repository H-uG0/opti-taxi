/**
 * Published versions of a crew's roadmap (DAY-04): what the crew sees of its route (the stops in order, each one's
 * planned time, the trips cancelled while still on it), a fingerprint of it, and what changed between the version
 * the crew last acknowledged (« J'ai vu ») and the latest one: « 1 course retirée, 1 décalée ».
 *
 * A version holds trip ids, stop kinds and minutes only: never a name, an address or a note. The phone keeps nothing
 * of it (the server tells it what changed, the page shows the stops).
 *
 * Pure: shared by the driver's sync route (app/api/chauffeur/roadmap), the regulator's live view and the tests.
 */
import type { StopKind } from "@prisma/client";
import { formatMinute } from "@/lib/time";

/** A planned time moved by less than this is not a change worth telling the crew. */
export const SHIFT_NOTICE_MIN = 5;

/** One stop of a version: trip id, « P » (pickup) or « D » (drop-off), planned minute, « c » when the trip is cancelled. */
export type RoadmapStop = { t: string; k: "P" | "D"; m: number; c?: 1 };

export type RoadmapSnapshot = { stops: RoadmapStop[]; fingerprint: string };

/** cyrb53: a short non-cryptographic hash, enough to notice that a roadmap changed. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The roadmap as the crew sees it now: its stops in route order, their planned start, the trips cancelled. */
export function roadmapSnapshot(
  stops: readonly { tripId: string; kind: StopKind; sequence: number; startMinute: number }[],
  cancelled: (tripId: string) => boolean,
): RoadmapSnapshot {
  const list: RoadmapStop[] = [...stops]
    .sort((a, b) => a.sequence - b.sequence)
    .map((stop) => ({ t: stop.tripId, k: stop.kind === "PICKUP" ? "P" : "D", m: stop.startMinute, ...(cancelled(stop.tripId) ? { c: 1 as const } : {}) }));
  return { stops: list, fingerprint: hash(list.map((s) => `${s.t}/${s.k}@${s.m}${s.c ? "x" : ""}`).join(",")) };
}

/** Reads the stops stored with a version (Json column); anything unreadable is dropped. */
export function storedStops(value: unknown): RoadmapStop[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): RoadmapStop[] => {
    if (!item || typeof item !== "object") return [];
    const { t, k, m, c } = item as Record<string, unknown>;
    if (typeof t !== "string" || (k !== "P" && k !== "D") || typeof m !== "number") return [];
    return [{ t, k, m, ...(c === 1 ? { c: 1 as const } : {}) }];
  });
}

/** What changed for the crew, trip by trip: taken off (or cancelled), added, moved by SHIFT_NOTICE_MIN or more. */
export type RoadmapChanges = {
  /** Trips no longer to do: with the planned minute of their first stop in the earlier version. */
  removed: { tripId: string; kind: StopKind; minute: number }[];
  /** Trips new on the route: their stops as keys « tripId/KIND » to highlight. */
  added: { tripId: string; kind: StopKind; minute: number }[];
  /** Trips still there whose planned time moved: the largest move of their stops. */
  shifted: { tripId: string; kind: StopKind; from: number; to: number }[];
  /** Stops to highlight on the roadmap (added or moved), as « tripId/PICKUP » keys. */
  highlight: string[];
};

const KIND: Record<RoadmapStop["k"], StopKind> = { P: "PICKUP", D: "DROPOFF" };

export function stopKey(tripId: string, kind: StopKind): string {
  return `${tripId}/${kind}`;
}

function byTrip(stops: readonly RoadmapStop[], live: boolean): Map<string, RoadmapStop[]> {
  const map = new Map<string, RoadmapStop[]>();
  for (const stop of stops) {
    if (live && stop.c) continue;
    map.set(stop.t, [...(map.get(stop.t) ?? []), stop]);
  }
  return map;
}

/** The changes from `before` (the version the crew acknowledged) to `after` (the latest). */
export function roadmapChanges(before: readonly RoadmapStop[], after: readonly RoadmapStop[]): RoadmapChanges {
  const was = byTrip(before, true);
  const is = byTrip(after, true);
  const changes: RoadmapChanges = { removed: [], added: [], shifted: [], highlight: [] };
  for (const [tripId, stops] of was) {
    if (is.has(tripId)) continue;
    const first = stops[0];
    if (first) changes.removed.push({ tripId, kind: KIND[first.k], minute: first.m });
  }
  for (const [tripId, stops] of is) {
    const earlier = was.get(tripId);
    const first = stops[0];
    if (!earlier) {
      if (first) changes.added.push({ tripId, kind: KIND[first.k], minute: first.m });
      changes.highlight.push(...stops.map((s) => stopKey(tripId, KIND[s.k])));
      continue;
    }
    let largest: { kind: StopKind; from: number; to: number } | null = null;
    for (const stop of stops) {
      const from = earlier.find((s) => s.k === stop.k)?.m;
      if (from === undefined) continue;
      if (Math.abs(stop.m - from) >= SHIFT_NOTICE_MIN && (!largest || Math.abs(stop.m - from) > Math.abs(largest.to - largest.from))) {
        largest = { kind: KIND[stop.k], from, to: stop.m };
      }
      if (Math.abs(stop.m - from) >= SHIFT_NOTICE_MIN) changes.highlight.push(stopKey(tripId, KIND[stop.k]));
    }
    if (largest) changes.shifted.push({ tripId, ...largest });
  }
  changes.removed.sort((a, b) => a.minute - b.minute);
  changes.added.sort((a, b) => a.minute - b.minute);
  changes.shifted.sort((a, b) => a.to - b.to);
  return changes;
}

export function hasChanges(changes: RoadmapChanges): boolean {
  return changes.removed.length + changes.added.length + changes.shifted.length > 0;
}

/** « 1 course retirée, 1 ajoutée, 2 décalées »: the first count names the trips, the next ones agree with it. */
export function changeCountsText(changes: Pick<RoadmapChanges, "removed" | "added" | "shifted">): string {
  const parts: [number, string][] = [
    [changes.removed.length, "retirée"],
    [changes.added.length, "ajoutée"],
    [changes.shifted.length, "décalée"],
  ];
  return parts
    .filter(([count]) => count > 0)
    .map(([count, word], i) => {
      const agreed = count > 1 ? `${word}s` : word;
      // No-break spaces: « 1 course » never splits over two lines.
      return i === 0 ? `${count}\u00a0${count > 1 ? "courses" : "course"} ${agreed}` : `${count}\u00a0${agreed}`;
    })
    .join(", ");
}

/** One version as stored (RouteVersion), with who acknowledged it. */
export type StoredVersion = {
  version: number;
  fingerprint: string;
  stops: RoadmapStop[];
  publishedAt: Date;
  seenAt: Date | null;
  seenByName?: string | null;
};

/** Where a crew stands with its roadmap: the version it acknowledged last, and what changed since. */
export type RoadmapStanding = {
  latest: StoredVersion;
  /** The latest version acknowledged (« J'ai vu », or the first opening for version 1), null when none. */
  seen: StoredVersion | null;
  /** Changes from the acknowledged version (or the first one) to the latest; empty when there is nothing to tell. */
  changes: RoadmapChanges;
  /** When the latest change worth telling was made, null when nothing is pending. */
  changedAt: Date | null;
};

/** `versions` of one vehicle and date, any order; null when there is none. */
export function roadmapStanding(versions: readonly StoredVersion[]): RoadmapStanding | null {
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const latest = sorted.at(-1);
  if (!latest) return null;
  const seen = [...sorted].reverse().find((v) => v.seenAt !== null) ?? null;
  const base = seen ?? sorted[0] ?? latest;
  const changes = roadmapChanges(base.stops, latest.stops);
  let changedAt: Date | null = null;
  if (hasChanges(changes)) {
    // The latest version after the base that changed something worth telling from the one before it.
    const after = sorted.filter((v) => v.version > base.version);
    for (const [i, version] of after.entries()) {
      const previous = i === 0 ? base : after[i - 1];
      if (previous && hasChanges(roadmapChanges(previous.stops, version.stops))) changedAt = version.publishedAt;
    }
    changedAt ??= latest.publishedAt;
  }
  return { latest, seen, changes, changedAt };
}

/**
 * When the change was made: the latest update of the route or of a trip it concerns (taken off, added, moved,
 * cancelled), never before the previous version and never after the moment it was noticed.
 */
export function publicationTime(args: { previous: Date | null; noticedAt: Date; updates: readonly Date[] }): Date {
  const latest = args.updates.reduce((max, at) => (at > max ? at : max), new Date(0));
  const floor = args.previous ?? new Date(0);
  const at = latest > floor ? latest : args.noticedAt;
  return at > args.noticedAt ? args.noticedAt : at;
}

/** The trips a change between two versions concerns (any stop added, removed, moved, cancelled or put back). */
export function changedTripIds(before: readonly RoadmapStop[], after: readonly RoadmapStop[]): string[] {
  const key = (s: RoadmapStop) => `${s.k}@${s.m}${s.c ? "x" : ""}`;
  const was = new Map<string, string>();
  for (const stop of before) was.set(stop.t, `${was.get(stop.t) ?? ""}|${key(stop)}`);
  const is = new Map<string, string>();
  for (const stop of after) is.set(stop.t, `${is.get(stop.t) ?? ""}|${key(stop)}`);
  const ids = new Set<string>();
  for (const [tripId, text] of was) if (is.get(tripId) !== text) ids.add(tripId);
  for (const tripId of is.keys()) if (!was.has(tripId)) ids.add(tripId);
  return [...ids];
}

/** The regulator's line about a crew's roadmap (« Modifiée à 10:42, pas encore vue »), null with no version yet. */
export function roadmapStateText(args: {
  standing: Pick<RoadmapStanding, "latest" | "seen" | "changes" | "changedAt"> | null;
  /** The route as stored now has another fingerprint than the latest version: the phone has not checked since. */
  undelivered: boolean;
  time: (instant: Date) => string;
}): { text: string; tone: "ok" | "pending" | "info" } | null {
  const { standing, undelivered, time } = args;
  if (!standing) return { text: "Feuille de route pas encore ouverte sur le téléphone", tone: "info" };
  const { seen, changes, changedAt } = standing;
  const who = seen?.seenByName ? ` par ${seen.seenByName}` : "";
  if (hasChanges(changes) && changedAt) {
    const since = `Modifiée à ${time(changedAt)} (${changeCountsText(changes)})`;
    return { text: `${since}, pas encore vue${undelivered ? "\u202f; nouvelle modification pas encore reçue" : ""}`, tone: "pending" };
  }
  const seenText = seen?.seenAt
    ? seen.version === 1
      ? `Ouverte à ${time(seen.seenAt)}${who}`
      : `Changements vus à ${time(seen.seenAt)}${who}`
    : "Ouverte sur le téléphone";
  return { text: undelivered ? `${seenText}\u202f; modifiée depuis, pas encore reçue sur le téléphone` : seenText, tone: undelivered ? "pending" : "ok" };
}

/** « retirée : prise en charge prévue à 10:30 » for the crew's banner (no name: the trip is no longer on the page). */
export function removedText(removed: RoadmapChanges["removed"][number]): string {
  return `${removed.kind === "PICKUP" ? "prise en charge" : "dépose"} prévue à ${formatMinute(removed.minute)}`;
}
