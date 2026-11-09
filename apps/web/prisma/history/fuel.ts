/**
 * Fill-ups and odometer readings consistent with the simulated km (pure,
 * unit-tested). After the days are simulated, each vehicle's fill-ups of the
 * window (those of the seed and of a previous simulation, never those
 * recorded in the app: fuelDecision) are rebuilt from the km it drove each
 * day: the planned km of its route on a day with stored routes (a simulated
 * day, of this run or an earlier one, or a day planned in the app; 0 when it
 * stayed at the depot), its average on the other working days, none on
 * Sundays. The last reading of the window stays the same (deadlines by km
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
 * Km of each day of the window: the route's km on a day whose routes are
 * stored (`plannedDays`, any vehicle; 0 when this vehicle had no route),
 * `nominalKm` on the other days, 0 on Sundays.
 */
export function dailyKm(
  dates: readonly string[],
  options: { plannedDays: ReadonlySet<string>; routeKm: ReadonlyMap<string, number>; nominalKm: number; isSunday: (date: string) => boolean },
): DayKm[] {
  return dates.map((date) => ({
    date,
    km: options.isSunday(date) ? 0 : options.plannedDays.has(date) ? (options.routeKm.get(date) ?? 0) : options.nominalKm,
  }));
}

/** A fill-up stored up to yesterday. */
export type StoredFill = { id: string; date: string; odometerKm: number };

export type FuelDecision =
  /** Rebuild the window from `from`: delete `ownedIds`, end on `finalOdometerKm`. */
  | { kind: "rebuild"; from: string; ownedIds: string[]; finalOdometerKm: number }
  /** A fill-up recorded in the app falls in the window: everything is left as it is. */
  | { kind: "app-fill-up" }
  /** No fill-up the seed or a simulation wrote (an older seed's, or the app's only): left as it is. */
  | { kind: "not-owned" };

/**
 * What to do with a vehicle's fill-ups: those the seed or a simulation wrote
 * (`owned`) are rebuilt over a window starting at the oldest of them, or at
 * `defaultFrom` when that is earlier, unless a fill-up recorded in the app
 * falls in that window (it is never replaced, nor contradicted). A fill-up of
 * the app before the window does not stop the rebuild. The last reading
 * stays: the deadlines by km (oil change…) keep their meaning.
 */
export function fuelDecision(fills: readonly StoredFill[], owned: (id: string) => boolean, defaultFrom: string): FuelDecision {
  const own = fills.filter((fill) => owned(fill.id));
  if (own.length === 0) return { kind: "not-owned" };
  const from = own.reduce((min, fill) => (fill.date < min ? fill.date : min), defaultFrom);
  if (fills.some((fill) => !owned(fill.id) && fill.date >= from)) return { kind: "app-fill-up" };
  return {
    kind: "rebuild",
    from,
    ownedIds: own.map((fill) => fill.id),
    finalOdometerKm: Math.max(...own.map((fill) => fill.odometerKm)),
  };
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
