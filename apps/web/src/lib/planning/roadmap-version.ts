/**
 * Published versions of a crew's roadmap (DAY-04): what the crew sees of its route (the stops in order, each one's
 * planned time, the end of session of each return to collect, the trips cancelled while still on it), a fingerprint
 * of it, and what changed between the version the crew last acknowledged (« J'ai vu ») and the latest one: « 1 course
 * retirée, 1 décalée ».
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

/**
 * One stop of a version: trip id, « P » (pickup) or « D » (drop-off), planned minute, « c » when the trip is cancelled,
 * « r » the end of session on the pickup of a return (the time its card shows: « Fin de séance à 14:00 »).
 */
export type RoadmapStop = { t: string; k: "P" | "D"; m: number; c?: 1; r?: number };

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

/**
 * The roadmap as the crew sees it now: its stops in route order, their planned start, the trips cancelled, and the end
 * of session of each return (`readyOf`: the trip's readyMinute for a return, null otherwise), on its pickup.
 */
export function roadmapSnapshot(
  stops: readonly { tripId: string; kind: StopKind; sequence: number; startMinute: number }[],
  cancelled: (tripId: string) => boolean,
  readyOf: (tripId: string) => number | null = () => null,
): RoadmapSnapshot {
  const list: RoadmapStop[] = [...stops]
    .sort((a, b) => a.sequence - b.sequence)
    .map((stop) => {
      const ready = stop.kind === "PICKUP" ? readyOf(stop.tripId) : null;
      return {
        t: stop.tripId,
        k: stop.kind === "PICKUP" ? "P" : "D",
        m: stop.startMinute,
        ...(cancelled(stop.tripId) ? { c: 1 as const } : {}),
        ...(ready !== null ? { r: ready } : {}),
      };
    });
  return { stops: list, fingerprint: hash(list.map(stopText).join(",")) };
}

/** « a/P@480 », « b/P@570x~600 »: one stop in the fingerprint and in changedTripIds. */
function stopText(stop: RoadmapStop): string {
  return `${stop.t}/${stop.k}@${stop.m}${stop.c ? "x" : ""}${stop.r !== undefined ? `~${stop.r}` : ""}`;
}

/** Reads the stops stored with a version (Json column); anything unreadable is dropped. */
export function storedStops(value: unknown): RoadmapStop[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): RoadmapStop[] => {
    if (!item || typeof item !== "object") return [];
    const { t, k, m, c, r } = item as Record<string, unknown>;
    if (typeof t !== "string" || (k !== "P" && k !== "D") || typeof m !== "number") return [];
    return [{ t, k, m, ...(c === 1 ? { c: 1 as const } : {}), ...(typeof r === "number" ? { r } : {}) }];
  });
}

/**
 * What changed for the crew, trip by trip: taken off (or cancelled), added, moved by SHIFT_NOTICE_MIN or more (its
 * planned time, or the end of session of a return).
 */
export type RoadmapChanges = {
  /** Trips no longer to do: with the planned minute of their first stop in the earlier version. */
  removed: { tripId: string; kind: StopKind; minute: number }[];
  /** Trips new on the route: their stops as keys « tripId/KIND » to highlight. */
  added: { tripId: string; kind: StopKind; minute: number }[];
  /** Trips still there whose planned time (or end of session) moved: the largest move of their stops. */
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
      const was = earlier.find((s) => s.k === stop.k);
      if (!was) continue;
      // The planned time, and on a return's pickup its end of session (a version stored before it was kept has none).
      const moves: [number, number][] = [[was.m, stop.m]];
      if (was.r !== undefined && stop.r !== undefined) moves.push([was.r, stop.r]);
      let moved = false;
      for (const [from, to] of moves) {
        if (Math.abs(to - from) < SHIFT_NOTICE_MIN) continue;
        moved = true;
        if (!largest || Math.abs(to - from) > Math.abs(largest.to - largest.from)) largest = { kind: KIND[stop.k], from, to };
      }
      if (moved) changes.highlight.push(stopKey(tripId, KIND[stop.k]));
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
  /** The crew member (Driver) whose account acknowledged it; undefined when not read. */
  seenByDriverId?: string | null;
};

/**
 * The acknowledgements that count for the route's crew now: its driver's or crew mate's. A crew put on the vehicle
 * by « Changer l'équipage » has seen nothing of it yet, whatever the previous crew acknowledged.
 */
export function seenByCrew(crew: { driverId: string | null; crewMateId: string | null }): (version: StoredVersion) => boolean {
  return (version) =>
    version.seenByDriverId === undefined ||
    (version.seenByDriverId !== null && (version.seenByDriverId === crew.driverId || version.seenByDriverId === crew.crewMateId));
}

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

/**
 * `versions` of one vehicle and date, any order (at least the latest acknowledged and the later ones); null when there
 * is none. `counts`: the acknowledgements that count (seenByCrew), any by default.
 */
export function roadmapStanding(versions: readonly StoredVersion[], counts: (version: StoredVersion) => boolean = () => true): RoadmapStanding | null {
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const latest = sorted.at(-1);
  if (!latest) return null;
  const seen = [...sorted].reverse().find((v) => v.seenAt !== null && counts(v)) ?? null;
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
  const was = new Map<string, string>();
  for (const stop of before) was.set(stop.t, `${was.get(stop.t) ?? ""}|${stopText(stop)}`);
  const is = new Map<string, string>();
  for (const stop of after) is.set(stop.t, `${is.get(stop.t) ?? ""}|${stopText(stop)}`);
  const ids = new Set<string>();
  for (const [tripId, text] of was) if (is.get(tripId) !== text) ids.add(tripId);
  for (const tripId of is.keys()) if (!was.has(tripId)) ids.add(tripId);
  return [...ids];
}

/** Changes the crew has not acknowledged, up to the roadmap as stored now. */
export type RoadmapPending = {
  changes: RoadmapChanges;
  /** When the latest of them was made. */
  changedAt: Date;
  /** The phone has them (published); false: made since its latest check (screen off, no network…). */
  received: boolean;
};

/**
 * What the crew has not acknowledged of its roadmap as stored now (`current`), worth telling (a move under
 * SHIFT_NOTICE_MIN is not): the versions its phone published since « J'ai vu », and what changed since the phone's
 * latest check. Null when nothing is pending, or when the crew has not opened its roadmap yet (there is nothing
 * earlier to compare with). `undeliveredAt`: when the change not received yet was made (publicationTime), asked only
 * when there is one.
 */
export function roadmapPending(standing: RoadmapStanding | null, current: RoadmapSnapshot, undeliveredAt: () => Date): RoadmapPending | null {
  if (!standing?.seen) return null;
  const changes = roadmapChanges(standing.seen.stops, current.stops);
  if (!hasChanges(changes)) return null;
  const undelivered = standing.latest.fingerprint !== current.fingerprint && hasChanges(roadmapChanges(standing.latest.stops, current.stops));
  if (undelivered) return { changes, changedAt: undeliveredAt(), received: false };
  return { changes, changedAt: standing.changedAt ?? standing.latest.publishedAt, received: true };
}

/**
 * The regulator's line about a crew's roadmap, naming it (« Feuille de route modifiée à 10:42 (1 course retirée), pas
 * encore vue »): not opened yet, opened, up to date and seen, or changed and not seen (or not received).
 */
export function roadmapStateText(args: {
  standing: Pick<RoadmapStanding, "seen"> | null;
  pending: RoadmapPending | null;
  time: (instant: Date) => string;
}): { text: string; tone: "ok" | "pending" | "info" } {
  const { standing, pending, time } = args;
  const seen = standing?.seen ?? null;
  if (!seen?.seenAt) return { text: "Feuille de route pas encore ouverte sur le téléphone", tone: "info" };
  if (pending) {
    const state = pending.received ? "pas encore vue" : "pas encore reçue sur le téléphone";
    return { text: `Feuille de route modifiée à ${time(pending.changedAt)} (${changeCountsText(pending.changes)}), ${state}`, tone: "pending" };
  }
  const who = seen.seenByName ? ` par ${seen.seenByName}` : "";
  return { text: `${seen.version === 1 ? "Feuille de route ouverte" : "Feuille de route à jour, vue"} à ${time(seen.seenAt)}${who}`, tone: "ok" };
}

/** « retirée : prise en charge prévue à 10:30 » for the crew's banner (no name: the trip is no longer on the page). */
export function removedText(removed: RoadmapChanges["removed"][number]): string {
  return `${removed.kind === "PICKUP" ? "prise en charge" : "dépose"} prévue à ${formatMinute(removed.minute)}`;
}
