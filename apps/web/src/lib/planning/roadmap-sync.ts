/**
 * A crew's phone checking its roadmap (DAY-04, POST /api/chauffeur/roadmap): each route of the crew on the date gets
 * its version published when it changed since the latest one (RouteVersion), and the phone is told what changed since
 * the version the crew acknowledged. Version 1 is acknowledged by its first opening (there is nothing earlier to
 * compare with), and so is the latest one when a new crew opens it (« Changer l'équipage »: what the previous crew saw
 * does not count for it). « J'ai vu » acknowledges the latest version.
 *
 * Takes the Prisma client as a parameter (no server-only import); the route handler writes the audit event of « J'ai vu ».
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { fromIsoDate } from "@/lib/time";
import {
  changedTripIds,
  changeCountsText,
  hasChanges,
  publicationTime,
  roadmapSnapshot,
  roadmapStanding,
  seenByCrew,
  storedStops,
  type RoadmapChanges,
  type StoredVersion,
} from "./roadmap-version";

/** What the phone is told about one route: no name, no address, only counts, times and opaque keys. */
export type CrewRoadmapState = {
  vehicleId: string;
  /** Latest version published. */
  version: number;
  /** Fingerprint of the roadmap as stored now: the page shown is stale when its own differs. */
  fingerprint: string;
  /** Changes not acknowledged yet, null when there is nothing to tell. */
  pending: {
    /** ISO instant of the latest change worth telling. */
    changedAt: string;
    /** « 1 course retirée, 1 décalée ». */
    text: string;
    removed: RoadmapChanges["removed"];
    /** Stops to highlight, « tripId/KIND ». */
    highlight: string[];
  } | null;
};

type Client = Pick<PrismaClient, "route" | "trip" | "routeVersion">;

const VERSION_SELECT = {
  version: true,
  fingerprint: true,
  stops: true,
  publishedAt: true,
  seenAt: true,
  seenBy: { select: { driverId: true } },
} satisfies Prisma.RouteVersionSelect;

function toStored(row: Prisma.RouteVersionGetPayload<{ select: typeof VERSION_SELECT }>): StoredVersion {
  return {
    version: row.version,
    fingerprint: row.fingerprint,
    stops: storedStops(row.stops),
    publishedAt: row.publishedAt,
    seenAt: row.seenAt,
    seenByDriverId: row.seenBy?.driverId ?? null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Publishes the routes of `driverId` (at the wheel or crew mate) on isoDate when they changed, and says where the
 * crew stands with each. `userId`: the account opening the roadmap (version 1 is acknowledged by it).
 */
export async function syncCrewRoadmaps(client: Client, args: { isoDate: string; driverId: string; userId: string; now: Date }): Promise<CrewRoadmapState[]> {
  const { isoDate, driverId, userId, now } = args;
  const serviceDate = fromIsoDate(isoDate);
  const routes = await client.route.findMany({
    where: { serviceDate, OR: [{ driverId }, { crewMateId: driverId }] },
    select: {
      vehicleId: true,
      driverId: true,
      crewMateId: true,
      updatedAt: true,
      stops: {
        select: { tripId: true, kind: true, sequence: true, startMinute: true, trip: { select: { status: true, direction: true, readyMinute: true } } },
      },
    },
  });
  const states: CrewRoadmapState[] = [];
  for (const route of routes) {
    const tripOf = (tripId: string) => route.stops.find((s) => s.tripId === tripId)?.trip;
    const current = roadmapSnapshot(
      route.stops,
      (tripId) => tripOf(tripId)?.status === "CANCELLED",
      (tripId) => {
        const trip = tripOf(tripId);
        return trip?.direction === "RETURN" ? trip.readyMinute : null;
      },
    );
    const where = { serviceDate, vehicleId: route.vehicleId };
    let versions = (await client.routeVersion.findMany({ where, select: VERSION_SELECT, orderBy: { version: "asc" } })).map(toStored);
    const latest = versions.at(-1);
    if (!latest || latest.fingerprint !== current.fingerprint) {
      let publishedAt = now;
      if (latest) {
        // When the regulation made the change: the latest update of the route or of a trip it concerns.
        const tripIds = changedTripIds(latest.stops, current.stops);
        const trips = tripIds.length > 0 ? await client.trip.findMany({ where: { id: { in: tripIds } }, select: { updatedAt: true } }) : [];
        publishedAt = publicationTime({ previous: latest.publishedAt, noticedAt: now, updates: [route.updatedAt, ...trips.map((t) => t.updatedAt)] });
      }
      try {
        await client.routeVersion.create({
          data: {
            ...where,
            version: (latest?.version ?? 0) + 1,
            fingerprint: current.fingerprint,
            stops: current.stops,
            publishedAt,
            createdAt: now,
            // The first opening is the crew's first sight of the roadmap: nothing earlier to tell them about.
            ...(latest ? {} : { seenAt: now, seenById: userId }),
          },
        });
      } catch (error) {
        // The other crew member's phone published the same version a moment before.
        if (!isUniqueViolation(error)) throw error;
      }
      versions = (await client.routeVersion.findMany({ where, select: VERSION_SELECT, orderBy: { version: "asc" } })).map(toStored);
    }
    const crewSaw = seenByCrew(route);
    let standing = roadmapStanding(versions, crewSaw);
    if (!standing) continue;
    if (!standing.seen) {
      // A crew opening a roadmap it never saw (put on the vehicle after its first opening): its first sight, nothing
      // earlier to tell it about. The previous crew's acknowledgement of that version is replaced.
      await client.routeVersion.updateMany({ where: { ...where, version: standing.latest.version }, data: { seenAt: now, seenById: userId } });
      versions = (await client.routeVersion.findMany({ where, select: VERSION_SELECT, orderBy: { version: "asc" } })).map(toStored);
      standing = roadmapStanding(versions, crewSaw);
      if (!standing) continue;
    }
    const { changes, changedAt } = standing;
    states.push({
      vehicleId: route.vehicleId,
      version: standing.latest.version,
      fingerprint: current.fingerprint,
      pending:
        hasChanges(changes) && changedAt
          ? { changedAt: changedAt.toISOString(), text: changeCountsText(changes), removed: changes.removed, highlight: changes.highlight }
          : null,
    });
  }
  return states;
}

/**
 * « J'ai vu »: the crew acknowledges version `version` of the route of `vehicleId` (a later version, published
 * meanwhile, stays to acknowledge). Returns the route's id for the audit event, null when the route is not the
 * driver's or the version does not exist.
 */
export async function acknowledgeRoadmap(
  client: Pick<PrismaClient, "route" | "routeVersion"> | Pick<Prisma.TransactionClient, "route" | "routeVersion">,
  args: { isoDate: string; vehicleId: string; version: number; driverId: string; userId: string; now: Date },
): Promise<{ routeId: string } | null> {
  const serviceDate = fromIsoDate(args.isoDate);
  const route = await client.route.findFirst({
    where: { serviceDate, vehicleId: args.vehicleId, OR: [{ driverId: args.driverId }, { crewMateId: args.driverId }] },
    select: { id: true },
  });
  if (!route) return null;
  const updated = await client.routeVersion.updateMany({
    where: { serviceDate, vehicleId: args.vehicleId, version: args.version, seenAt: null },
    data: { seenAt: args.now, seenById: args.userId },
  });
  if (updated.count === 0) {
    const exists = await client.routeVersion.findFirst({ where: { serviceDate, vehicleId: args.vehicleId, version: args.version }, select: { id: true } });
    if (!exists) return null;
  }
  return { routeId: route.id };
}
