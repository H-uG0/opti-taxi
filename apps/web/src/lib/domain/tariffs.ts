/**
 * Tariff grid selection. Amounts live in the database, never in code.
 *
 * The web picks the grid of each vehicle (the optimizer no longer looks one
 * up): a taxi by the department of its ADS (Vehicle.department), a VSL or an
 * ambulance by the company's certification on the date (CompanyCertification)
 * and the department of its head office (AppSettings.hqDepartment; the
 * vehicle's own department while it is not set). A grid of department « * »
 * covers every department; a grid whose `certified` is null applies whatever
 * the certification.
 */
import type { Prisma, TariffGrid, VehicleType } from "@prisma/client";
import { z } from "zod";
import { addDays, toIsoDate } from "@/lib/time";
import type { FareGrid, SharedDiscount, ShortTripBand } from "./fare";

export const ALL_DEPARTMENTS = "*";

/**
 * What grid selection reads: full rows, or the subset the optimizer request is
 * built from. createdAt and id only break same-day ties (see supersedes); they
 * are required so a caller selecting a subset of columns cannot leave them out.
 */
type DatedGrid = Pick<TariffGrid, "vehicleType" | "department" | "certified" | "validFrom" | "validTo" | "createdAt" | "id">;
type SelectableGrid = Pick<TariffGrid, "vehicleType" | "department" | "certified">;

/**
 * Does `grid` supersede `current`? The later start wins; on the same start day
 * (e.g. a grid duplicated the same day to fix a typo) the one created last
 * wins, then the greater id, so the result never depends on the input order.
 */
function supersedes(grid: DatedGrid, current: DatedGrid): boolean {
  const byStart = grid.validFrom.getTime() - current.validFrom.getTime();
  if (byStart !== 0) return byStart > 0;
  const byCreation = grid.createdAt.getTime() - current.createdAt.getTime();
  if (byCreation !== 0) return byCreation > 0;
  return grid.id > current.id;
}

/** What one grid in force stands for: type, department, certification ("TAXI/13/-", "VSL/13/base"). */
function gridKey(grid: SelectableGrid): string {
  const certification = grid.certified === null ? "-" : grid.certified ? "certified" : "base";
  return `${grid.vehicleType}/${grid.department}/${certification}`;
}

/**
 * Grids in force on isoDate, one per (vehicleType, department, certification):
 * when several overlap, the one that started most recently wins (ties: last created).
 */
export function tariffsInForce<T extends DatedGrid>(grids: T[], isoDate: string): T[] {
  const best = new Map<string, T>();
  for (const grid of grids) {
    const from = toIsoDate(grid.validFrom);
    const to = grid.validTo ? toIsoDate(grid.validTo) : null;
    if (from > isoDate || (to !== null && to < isoDate)) continue;
    const key = gridKey(grid);
    const current = best.get(key);
    if (!current || supersedes(grid, current)) best.set(key, grid);
  }
  return [...best.values()];
}

/** The company's situation on a date, as grid selection reads it. */
export type CompanyTariffStatus = { certified: boolean; hqDepartment: string | null };

/** Company settings over time: certification periods and head office. */
export type CompanyTariffContext = {
  certifications: readonly { validFrom: Date; validTo: Date | null }[];
  hqDepartment: string | null;
};

export const NO_COMPANY_CONTEXT: CompanyTariffContext = { certifications: [], hqDepartment: null };

/** Is the company certified on isoDate (a period covers it, bounds included)? */
export function certifiedOn(certifications: CompanyTariffContext["certifications"], isoDate: string): boolean {
  return certifications.some(
    (period) => toIsoDate(period.validFrom) <= isoDate && (period.validTo === null || toIsoDate(period.validTo) >= isoDate),
  );
}

export function companyStatusOn(company: CompanyTariffContext, isoDate: string): CompanyTariffStatus {
  return { certified: certifiedOn(company.certifications, isoDate), hqDepartment: company.hqDepartment };
}

/**
 * Grid of a vehicle among the grids in force: departments in order (taxi: its
 * ADS department; VSL and ambulance: the head office's, else its own), then
 * « * »; in each, the grid of the company's certification before a grid that
 * applies to any company.
 */
export function gridForVehicle<T extends SelectableGrid>(
  inForce: readonly T[],
  vehicle: { type: VehicleType; department: string },
  company: CompanyTariffStatus,
): T | undefined {
  const own = vehicle.type === "TAXI" ? vehicle.department : (company.hqDepartment ?? vehicle.department);
  for (const department of [own, ALL_DEPARTMENTS]) {
    const ofDepartment = inForce.filter((g) => g.vehicleType === vehicle.type && g.department === department);
    const found = ofDepartment.find((g) => g.certified === company.certified) ?? ofDepartment.find((g) => g.certified === null);
    if (found) return found;
  }
  return undefined;
}

/** A vehicle as tariff coverage reads it. */
export type TariffedVehicle = { label: string; type: VehicleType; department: string };

/** Vehicles of one (type, department) that no grid covers. */
export type TariffGap = { vehicleType: VehicleType; department: string; vehicles: string[] };

/** Vehicles grouped by (type, department), in the given order. */
function byTariffZone(vehicles: readonly TariffedVehicle[]): TariffGap[] {
  const groups = new Map<string, TariffGap>();
  for (const vehicle of vehicles) {
    const key = `${vehicle.type}/${vehicle.department}`;
    const group = groups.get(key) ?? { vehicleType: vehicle.type, department: vehicle.department, vehicles: [] };
    group.vehicles.push(vehicle.label);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Vehicles that no grid of `inForce` covers (gridForVehicle): the optimizer
 * estimates their revenue at 0 €. Grouped by (type, department), vehicles in
 * the given order.
 */
export function tariffGaps<G extends SelectableGrid>(
  vehicles: readonly TariffedVehicle[],
  inForce: readonly G[],
  company: CompanyTariffStatus,
): TariffGap[] {
  return byTariffZone(vehicles.filter((vehicle) => !gridForVehicle(inForce, vehicle, company)));
}

/**
 * A (type, department) of vehicles left without grid on a day of the window:
 * - "missing": no grid on the first day of the window;
 * - "expires": covered at first, until `expiring` ends (its validTo), with no
 *   grid taking over the next day.
 * `resumesOn` is the first later day of the window covered again, if any.
 */
export type TariffCoverageAlert = TariffGap & {
  kind: "missing" | "expires";
  /** First day without grid. */
  uncoveredFrom: string;
  /** "expires": the grid in force the day before. */
  expiring: (Pick<TariffGrid, "id" | "department" | "label"> & { validTo: string }) | null;
  resumesOn: string | null;
};

/**
 * Coverage of every (type, department) of `vehicles` from `fromIso` to
 * `fromIso + days` included: one alert per pair left without grid on a day of
 * the window (the planner works on tomorrow and the days after, a grid ending
 * today leaves tomorrow at 0 €). Days are checked with tariffsInForce and
 * gridForVehicle, with the company's certification of each day, as the
 * optimizer request does.
 */
export function tariffCoverageAlerts<G extends DatedGrid & Pick<TariffGrid, "label">>(
  vehicles: readonly TariffedVehicle[],
  grids: G[],
  fromIso: string,
  days: number,
  company: CompanyTariffContext = NO_COMPANY_CONTEXT,
): TariffCoverageAlert[] {
  const window = Array.from({ length: days + 1 }, (_, i) => addDays(fromIso, i));
  const inForceByDay = window.map((day) => ({ inForce: tariffsInForce(grids, day), status: companyStatusOn(company, day) }));
  const alerts: TariffCoverageAlert[] = [];
  for (const gap of byTariffZone(vehicles)) {
    const vehicle = { type: gap.vehicleType, department: gap.department };
    const covering = inForceByDay.map(({ inForce, status }) => gridForVehicle(inForce, vehicle, status) ?? null);
    const firstGap = covering.findIndex((grid) => grid === null);
    if (firstGap < 0) continue;
    const resumes = covering.findIndex((grid, i) => i > firstGap && grid !== null);
    const before = firstGap > 0 ? covering[firstGap - 1] : null;
    alerts.push({
      ...gap,
      kind: before ? "expires" : "missing",
      uncoveredFrom: window[firstGap]!,
      expiring:
        before && before.validTo
          ? { id: before.id, department: before.department, label: before.label, validTo: toIsoDate(before.validTo) }
          : null,
      resumesOn: resumes < 0 ? null : window[resumes]!,
    });
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// The JSON columns of a grid, and the grid as fare.ts and the contract read it.

const shortTripBandsSchema = z.array(z.object({ upToKm: z.number().min(0), amount: z.number().min(0) }));
const sharedDiscountsSchema = z.array(z.object({ patients: z.number().int().min(2).max(8), rate: z.number().min(0).max(1) }));

/** TariffGrid.shortTripBands, sorted by distance; [] for a malformed value. */
export function readShortTripBands(value: Prisma.JsonValue): ShortTripBand[] {
  const parsed = shortTripBandsSchema.safeParse(value);
  return parsed.success ? [...parsed.data].sort((a, b) => a.upToKm - b.upToKm) : [];
}

/** TariffGrid.sharedDiscounts, sorted by number of patients; [] for a malformed value. */
export function readSharedDiscounts(value: Prisma.JsonValue): SharedDiscount[] {
  const parsed = sharedDiscountsSchema.safeParse(value);
  return parsed.success ? [...parsed.data].sort((a, b) => a.patients - b.patients) : [];
}

/** The pricing columns of a grid. */
export type PricedGrid = Pick<
  TariffGrid,
  | "baseFare"
  | "aggloFare"
  | "bigCityFare"
  | "includedKm"
  | "pricePerKm"
  | "shortTripBands"
  | "nightRate"
  | "weekendRate"
  | "nightStartMinute"
  | "nightEndMinute"
  | "saturdayFromMinute"
  | "surchargeShortTrip"
  | "emptyLegRateShort"
  | "emptyLegRateLong"
  | "emptyLegThresholdKm"
  | "sharedDiscounts"
  | "maxSharedPatients"
  | "aloneDiscount"
  | "aloneThresholdKm"
  | "billableDetourKm"
  | "tpmrFare"
>;

/** A grid row as fare.ts computes with it. */
export function toFareGrid(grid: PricedGrid): FareGrid {
  return {
    baseFare: grid.baseFare,
    aggloFare: grid.aggloFare,
    bigCityFare: grid.bigCityFare,
    includedKm: grid.includedKm,
    pricePerKm: grid.pricePerKm,
    shortTripBands: readShortTripBands(grid.shortTripBands),
    nightRate: grid.nightRate,
    weekendRate: grid.weekendRate,
    nightStartMinute: grid.nightStartMinute,
    nightEndMinute: grid.nightEndMinute,
    saturdayFromMinute: grid.saturdayFromMinute,
    surchargeShortTrip: grid.surchargeShortTrip,
    emptyLegRateShort: grid.emptyLegRateShort,
    emptyLegRateLong: grid.emptyLegRateLong,
    emptyLegThresholdKm: grid.emptyLegThresholdKm,
    sharedDiscounts: readSharedDiscounts(grid.sharedDiscounts),
    maxSharedPatients: grid.maxSharedPatients,
    aloneDiscount: grid.aloneDiscount,
    aloneThresholdKm: grid.aloneThresholdKm,
    billableDetourKm: [...grid.billableDetourKm],
    tpmrFare: grid.tpmrFare,
  };
}
