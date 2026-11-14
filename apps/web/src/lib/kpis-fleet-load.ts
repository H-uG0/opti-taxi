/**
 * The fleet of each dashboard date (KPI-03): the crews of the day resolved
 * as the planning resolves them (lib/staff/day-crews.ts), then counted by
 * kpis-fleet.ts. Seven queries for the whole set of dates, one resolution per
 * date. No server-only import: the client is passed in.
 *
 * Today's records stand for the past: a vehicle or a person deactivated since
 * no longer counts, the working days are today's. The vehicles that had a
 * route are counted active and available whatever (kpis-fleet.ts fleetOfDay).
 */
import type { PrismaClient } from "@prisma/client";
import { fleetDayFromCrews } from "@/lib/kpis-fleet";
import type { KpiFleetDay } from "@/lib/kpis-rows";
import { driverInputSelect, loadCrewRules } from "@/lib/optimizer/build-request";
import { resolveDayCrews } from "@/lib/staff/day-crews";
import { fromIsoDate, toIsoDate } from "@/lib/time";

export type FleetClient = Pick<
  PrismaClient,
  "vehicle" | "driver" | "staffAbsence" | "crewIncompatibility" | "dayCrew" | "vehicleUnavailability" | "depot" | "appSettings"
>;

/** The fleet of each date (in the given order); the dates may be scattered. */
export async function loadKpiFleet(prisma: FleetClient, dates: readonly string[]): Promise<KpiFleetDay[]> {
  if (dates.length === 0) return [];
  const sorted = [...dates].sort();
  const first = fromIsoDate(sorted[0] ?? "");
  const last = fromIsoDate(sorted[sorted.length - 1] ?? "");
  const covering = { startDate: { lte: last }, endDate: { gte: first } };
  const [vehicles, people, absences, incompatibilities, saved, outages, depots, rules] = await Promise.all([
    prisma.vehicle.findMany({
      select: { id: true, label: true, type: true, active: true, depotId: true, defaultDriverId: true, defaultCrewMateId: true },
    }),
    prisma.driver.findMany({ select: { ...driverInputSelect, qualifications: true, depotId: true } }),
    prisma.staffAbsence.findMany({ where: covering, select: { driverId: true, kind: true, startDate: true, endDate: true } }),
    prisma.crewIncompatibility.findMany({ select: { driverAId: true, driverBId: true } }),
    prisma.dayCrew.findMany({
      where: { serviceDate: { in: sorted.map(fromIsoDate) } },
      select: { serviceDate: true, vehicleId: true, driverId: true, crewMateId: true },
    }),
    prisma.vehicleUnavailability.findMany({ where: covering, select: { vehicleId: true, kind: true, startDate: true, endDate: true } }),
    prisma.depot.findMany({ select: { id: true, name: true, lat: true, lng: true } }),
    loadCrewRules(prisma),
  ]);
  const datedAbsences = absences.map((a) => ({ ...a, startDate: toIsoDate(a.startDate), endDate: toIsoDate(a.endDate) }));
  const datedOutages = outages.map((u) => ({ ...u, startDate: toIsoDate(u.startDate), endDate: toIsoDate(u.endDate) }));
  return dates.map((date) => {
    const plan = resolveDayCrews({
      date,
      vehicles,
      people,
      absences: datedAbsences,
      incompatibilities,
      saved: saved.filter((s) => toIsoDate(s.serviceDate) === date),
      vehicleUnavailabilities: datedOutages,
      depots,
      rules,
    });
    return fleetDayFromCrews(date, plan.crews);
  });
}
