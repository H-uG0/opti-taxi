/**
 * Fill-ups and odometer readings consistent with the simulated km (pure,
 * unit-tested). After the days are simulated, each vehicle's fill-ups of the
 * window (those of the seed and of a previous simulation, never those
 * recorded in the app) are rebuilt from the km it drove each day: the
 * planned km of its route on a simulated day (0 when it stayed at the
 * depot), its average on the other working days (the seed's own days), none
 * on Sundays. The last reading of the window stays the same (deadlines by km
 * keep their meaning); the earlier ones are counted back from it. A vehicle
 * is filled up when its range is used (diesel every 450 to 650 km, an
 * electric car charged every 150 to 250 km), with the fuel of its
 * consumption ± 5 %; the last day the vehicle drove always ends with a reading.
 */
import type { Rng } from "../seed/random";

export type DayKm = { date: string; km: number };
export type FuelProfile = { per100Km: number; price: number };
export type RebuiltFill = { date: string; odometerKm: number; quantity: number; cost: number };

/** km between two fill-ups: [min, max]. */
export function refillRange(electric: boolean): readonly [number, number] {
  return electric ? [150, 250] : [450, 650];
}

/**
 * Km of each day of the window: the route's km on a simulated day (0 when the
 * vehicle had no route), `nominalKm` on the other days, 0 on Sundays.
 */
export function dailyKm(
  dates: readonly string[],
  options: { simulated: ReadonlySet<string>; routeKm: ReadonlyMap<string, number>; nominalKm: number; isSunday: (date: string) => boolean },
): DayKm[] {
  return dates.map((date) => ({
    date,
    km: options.isSunday(date) ? 0 : options.simulated.has(date) ? (options.routeKm.get(date) ?? 0) : options.nominalKm,
  }));
}

/** Average km of the simulated working days with a route; `fallback` when there is none. */
export function nominalKm(routeKm: ReadonlyMap<string, number>, fallback: number): number {
  const values = [...routeKm.values()].filter((km) => km > 0);
  return values.length === 0 ? fallback : Math.round(values.reduce((sum, km) => sum + km, 0) / values.length);
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * The fill-ups of the window, oldest first: a full tank on its first day
 * (start of the consumption measure), then one each time the range is used,
 * and one on the last day for the km left. `finalOdometerKm` is the reading
 * at the end of the last day.
 */
export function rebuildFuelLog(days: readonly DayKm[], finalOdometerKm: number, profile: FuelProfile, electric: boolean, rng: Rng): RebuiltFill[] {
  if (days.length === 0) return [];
  const total = days.reduce((sum, day) => sum + Math.max(0, day.km), 0);
  const [min, max] = refillRange(electric);
  const fills: RebuiltFill[] = [];
  const fill = (date: string, odometerKm: number, km: number) => {
    const quantity = round1(((km * profile.per100Km) / 100) * rng.float(0.95, 1.05));
    fills.push({ date, odometerKm, quantity, cost: Math.round(quantity * profile.price * 100) / 100 });
  };
  let driven = 0;
  let sinceFill = 0;
  let threshold = rng.int(min, max);
  // The last reading is taken on the last day the vehicle drove (not on a Sunday at the depot).
  const lastDriving = days.reduce((latest, day, index) => (day.km > 0 ? index : latest), days.length - 1);
  for (const [index, day] of days.entries()) {
    driven += Math.max(0, day.km);
    sinceFill += Math.max(0, day.km);
    const odometer = Math.round(finalOdometerKm - (total - driven));
    const last = index === lastDriving;
    if (index === 0) {
      // The first full tank: the quantity of a usual fill-up, it only starts the measure.
      fill(day.date, odometer, threshold);
      sinceFill = 0;
      threshold = rng.int(min, max);
    } else if (sinceFill >= threshold || (last && sinceFill > 0)) {
      fill(day.date, odometer, sinceFill);
      sinceFill = 0;
      threshold = rng.int(min, max);
    }
  }
  return fills;
}
