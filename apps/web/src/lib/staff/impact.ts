/**
 * What a staff change (absence, deactivation, pair not to put together) does
 * to the days already planned and to the crews fixed on the Équipages page,
 * said after the change with what the regulator can do on each day:
 * - a proposed day: re-run the optimization;
 * - a validated day: « Changer l'équipage » of the route on the planning, or
 *   reopen the planning and re-run it;
 * - a started day: « Changer l'équipage » of the route (no re-optimization);
 * - a fixed crew of a day still open to change: a replacement is proposed on
 *   it (absence, deactivation), or the pair has to be changed by hand.
 *
 * `staffImpactNotice` is pure (unit-tested); `loadStaffImpact` reads the rows,
 * with the Prisma client as a parameter (no server-only import).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { FIELD_TRIP_STATUSES } from "@/lib/optimizer/persist";
import { formatShortDate, fromIsoDate, todayIso, toIsoDate } from "@/lib/time";

export type DayState = "proposed" | "validated" | "started";

export type StaffImpact = {
  /** Days the person (or the pair, together) has a route, with the state of each day. */
  days: { date: string; state: DayState }[];
  /** Crews fixed with the person (or the pair) on days still open to change, in date order. */
  fixed: { date: string; vehicleLabel: string }[];
};

/** "person": an absence or a deactivation; "pair": two people no longer to put in one crew. */
export type ImpactSubject = "person" | "pair";

const MAX_LISTED = 5;

function dateList(dates: readonly string[]): { text: string; many: boolean } {
  const listed = dates.slice(0, MAX_LISTED).map(formatShortDate).join(", ");
  return { text: dates.length > MAX_LISTED ? `${listed}…` : listed, many: dates.length > 1 };
}

/** " Tournées déjà calculées avec … : relancez l'optimisation de ce jour depuis le planning. …", or "". */
export function staffImpactNotice(impact: StaffImpact, subject: ImpactSubject): string {
  const parts: string[] = [];
  const withWhom = subject === "pair" ? "avec ces deux personnes ensemble" : "avec cette personne";
  const of = (state: DayState) => impact.days.filter((day) => day.state === state).map((day) => day.date);

  const proposed = dateList(of("proposed"));
  if (proposed.text) {
    parts.push(
      `Tournées déjà calculées ${withWhom} le${proposed.many ? "s" : ""} ${proposed.text} : relancez l'optimisation de ${proposed.many ? "ces jours" : "ce jour"} depuis le planning.`,
    );
  }
  const validated = dateList(of("validated"));
  if (validated.text) {
    parts.push(
      `Planning déjà validé le${validated.many ? "s" : ""} ${validated.text} : changez l'équipage de la tournée (planning, panneau du véhicule, « Changer l'équipage ») ou rouvrez le planning puis relancez l'optimisation.`,
    );
  }
  const started = dateList(of("started"));
  if (started.text) {
    parts.push(
      `Journée commencée le${started.many ? "s" : ""} ${started.text} : changez l'équipage de la tournée (planning, panneau du véhicule, « Changer l'équipage »).`,
    );
  }
  if (impact.fixed.length > 0) {
    const listed = impact.fixed.slice(0, MAX_LISTED).map((crew) => `${crew.vehicleLabel} le ${formatShortDate(crew.date)}`);
    const text = `${listed.join(", ")}${impact.fixed.length > MAX_LISTED ? "…" : ""}`;
    const many = impact.fixed.length > 1;
    parts.push(
      subject === "pair"
        ? `Équipage${many ? "s" : ""} fixé${many ? "s" : ""} à revoir sur la page Équipages, ces deux personnes y sont ensemble : ${text}.`
        : `Équipage${many ? "s" : ""} fixé${many ? "s" : ""} avec cette personne : ${text} ; un remplaçant y est proposé, à vérifier sur la page Équipages.`,
    );
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/** The state of a day from its routes and the field activity (same rule as replanBlocker). */
export function dayStateOf(validated: boolean, started: boolean): DayState {
  if (started) return "started";
  return validated ? "validated" : "proposed";
}

type ImpactClient = Pick<PrismaClient, "route" | "dayCrew" | "trip" | "routeStop"> | Prisma.TransactionClient;

/**
 * Rows behind staffImpactNotice, from `from` (never before today) to `to`
 * included (null: no end). `pair`: only the routes and fixed crews where the
 * two people of `driverIds` work together.
 */
export async function loadStaffImpact(
  prisma: ImpactClient,
  driverIds: readonly string[],
  from: string,
  to: string | null,
  pair = false,
): Promise<StaffImpact> {
  const today = todayIso();
  if (to !== null && to < today) return { days: [], fixed: [] };
  const serviceDate = { gte: fromIsoDate(from > today ? from : today), ...(to ? { lte: fromIsoDate(to) } : {}) };
  const [a, b] = driverIds;
  const together =
    pair && a && b
      ? {
          OR: [
            { driverId: a, crewMateId: b },
            { driverId: b, crewMateId: a },
          ],
        }
      : { OR: [{ driverId: { in: [...driverIds] } }, { crewMateId: { in: [...driverIds] } }] };
  const [routes, fixedRows] = await Promise.all([
    prisma.route.findMany({ where: { serviceDate, ...together }, select: { serviceDate: true } }),
    prisma.dayCrew.findMany({
      where: { serviceDate, ...together },
      select: { serviceDate: true, vehicle: { select: { label: true } } },
      orderBy: { serviceDate: "asc" },
    }),
  ]);
  const dates = [...new Set(routes.map((route) => toIsoDate(route.serviceDate)))].sort();
  if (dates.length === 0 && fixedRows.length === 0) return { days: [], fixed: [] };
  const onDates = { in: dates.map(fromIsoDate) };
  const [validated, pickedUp, recorded] =
    dates.length > 0
      ? await Promise.all([
          prisma.route.findMany({
            where: { serviceDate: onDates, status: "VALIDATED" },
            select: { serviceDate: true },
            distinct: ["serviceDate"],
          }),
          prisma.trip.findMany({
            where: { serviceDate: onDates, status: { in: [...FIELD_TRIP_STATUSES] } },
            select: { serviceDate: true },
            distinct: ["serviceDate"],
          }),
          prisma.routeStop.findMany({
            where: { completedAt: { not: null }, route: { serviceDate: onDates } },
            select: { route: { select: { serviceDate: true } } },
            distinct: ["routeId"],
          }),
        ])
      : [[], [], []];
  const validatedDates = new Set(validated.map((row) => toIsoDate(row.serviceDate)));
  const startedDates = new Set([
    ...pickedUp.map((row) => toIsoDate(row.serviceDate)),
    ...recorded.map((row) => toIsoDate(row.route.serviceDate)),
  ]);
  const days = dates.map((date) => ({ date, state: dayStateOf(validatedDates.has(date), startedDates.has(date)) }));
  // A validated or started day keeps its routes: its fixed crews no longer count (the route does).
  const locked = new Set(days.filter((day) => day.state !== "proposed").map((day) => day.date));
  const fixed = fixedRows
    .map((row) => ({ date: toIsoDate(row.serviceDate), vehicleLabel: row.vehicle.label }))
    .filter((crew) => !locked.has(crew.date));
  return { days, fixed };
}
