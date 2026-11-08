/**
 * Fuel and charging log of a vehicle: last odometer reading, measured
 * consumption and energy cost per km. Pure module.
 *
 * Consumption is measured between full tanks: the fuel of every fill after
 * the first full one, up to the last full one, divided by the km driven
 * between those two. Partial fills in between count; those after the last
 * full tank wait for the next full one.
 */
import type { EnergyType } from "@prisma/client";

export type FuelEntry = { date: string; odometerKm: number; quantity: number; cost: number; fullTank: boolean };

export type ConsumptionStats = {
  /** Highest odometer reading, or null without any entry. */
  odometerKm: number | null;
  /** Date of that reading. */
  odometerDate: string | null;
  /** km between the first and the last full tank (0 if fewer than two). */
  measuredKm: number;
  /** Litres or kWh per 100 km, null when not measurable yet. */
  per100Km: number | null;
  /** Energy cost per km (€), null when not measurable yet. */
  costPerKm: number | null;
};

/** Unit of the quantity of a fill: kWh for an electric vehicle, litres otherwise. */
export function energyUnit(energy: EnergyType | null): "kWh" | "L" {
  return energy === "ELECTRIC" ? "kWh" : "L";
}

export function consumptionStats(entries: readonly FuelEntry[]): ConsumptionStats {
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.odometerKm - b.odometerKm);
  const last = sorted.reduce<FuelEntry | null>((best, e) => (!best || e.odometerKm >= best.odometerKm ? e : best), null);
  const fullIndexes = sorted.flatMap((e, i) => (e.fullTank ? [i] : []));
  const empty = { odometerKm: last?.odometerKm ?? null, odometerDate: last?.date ?? null, measuredKm: 0, per100Km: null, costPerKm: null };
  if (fullIndexes.length < 2) return empty;
  const first = fullIndexes[0]!;
  const lastFull = fullIndexes[fullIndexes.length - 1]!;
  const km = sorted[lastFull]!.odometerKm - sorted[first]!.odometerKm;
  if (km <= 0) return empty;
  const between = sorted.slice(first + 1, lastFull + 1);
  const quantity = between.reduce((sum, e) => sum + e.quantity, 0);
  const cost = between.reduce((sum, e) => sum + e.cost, 0);
  return {
    ...empty,
    measuredKm: km,
    per100Km: Math.round((quantity / km) * 1000) / 10,
    costPerKm: Math.round((cost / km) * 1000) / 1000,
  };
}
