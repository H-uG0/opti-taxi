import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { openFutureTripsWhere } from "./trip-sync-db";

/** Open trips (not started, not cancelled) from today on that a referential change would affect. */
export function countOpenTrips(where: Prisma.TripWhereInput, todayIso: string): Promise<number> {
  return db.trip.count({ where: openFutureTripsWhere(where, todayIso) });
}

/** Open trips from today on, per recurrence (trips without recurrence under the key ""). */
export async function countOpenTripsByRecurrence(
  where: Prisma.TripWhereInput,
  todayIso: string,
): Promise<Map<string, number>> {
  const groups = await db.trip.groupBy({
    by: ["recurrenceId"],
    where: openFutureTripsWhere(where, todayIso),
    _count: { _all: true },
  });
  return new Map(groups.map((g) => [g.recurrenceId ?? "", g._count._all]));
}
