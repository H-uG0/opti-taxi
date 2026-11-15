/**
 * The mileages known of the vehicles (FLD-03): the crew's odometer readings and the fill-ups. Takes the Prisma client
 * (or a transaction) as a parameter, like the other loaders shared with the optimizer request (no server-only import).
 */
import type { OdometerMoment, Prisma, PrismaClient } from "@prisma/client";
import { toIsoDate } from "@/lib/time";
import type { KmPoint } from "./odometer";

type Client = Pick<PrismaClient, "fuelLog" | "odometerReading"> | Pick<Prisma.TransactionClient, "fuelLog" | "odometerReading">;

/** The last known mileage of each vehicle (`vehicleIds`, or all): the highest of its readings and fill-ups. */
export async function loadLatestKm(client: Client, vehicleIds?: readonly string[]): Promise<Map<string, number>> {
  const where = vehicleIds ? { vehicleId: { in: [...vehicleIds] } } : {};
  const [fills, readings] = await Promise.all([
    client.fuelLog.groupBy({ by: ["vehicleId"], where, _max: { odometerKm: true } }),
    client.odometerReading.groupBy({ by: ["vehicleId"], where, _max: { km: true } }),
  ]);
  const latest = new Map<string, number>();
  for (const [vehicleId, km] of [
    ...fills.map((f) => [f.vehicleId, f._max.odometerKm] as const),
    ...readings.map((r) => [r.vehicleId, r._max.km] as const),
  ]) {
    if (km !== null && km > (latest.get(vehicleId) ?? -1)) latest.set(vehicleId, km);
  }
  return latest;
}

export type KmPointOf = KmPoint & { moment: OdometerMoment | "FILL" };

/** Every mileage known of one vehicle (readings with their moment, fill-ups), oldest first. */
export async function loadKmPoints(client: Client, vehicleId: string): Promise<KmPointOf[]> {
  const [fills, readings] = await Promise.all([
    client.fuelLog.findMany({ where: { vehicleId }, select: { date: true, odometerKm: true } }),
    client.odometerReading.findMany({ where: { vehicleId }, select: { serviceDate: true, km: true, moment: true } }),
  ]);
  return [
    ...fills.map((fill) => ({ date: toIsoDate(fill.date), km: fill.odometerKm, moment: "FILL" as const })),
    ...readings.map((reading) => ({ date: toIsoDate(reading.serviceDate), km: reading.km, moment: reading.moment })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.km - b.km);
}
