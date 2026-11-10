/**
 * One patient's invoice with a tariff grid, as the optimizer computes it
 * (services/optimizer/app/pricing.py; contract/README.md, « Calcul du CA
 * estimé d'une course »). Used by the simulator and the form preview of
 * /tarifs; both sides run contract/fixtures/fare-cases.json.
 *
 * Integer arithmetic (BigInt): amounts in 1/10 000 €, rates in 1/10 000,
 * distances in metres, each input rounded half up from its shortest decimal
 * writing; the invoice is rounded half up to the cent once, at the end.
 * Pure module.
 */
import { addDays, isoWeekday } from "@/lib/time";

export type ShortTripBand = { upToKm: number; amount: number };
export type SharedDiscount = { patients: number; rate: number };

/** The contract's Tariff, without its id and vehicle type. */
export type FareGrid = {
  baseFare: number;
  aggloFare: number | null;
  bigCityFare: number;
  includedKm: number;
  pricePerKm: number;
  shortTripBands: readonly ShortTripBand[];
  nightRate: number;
  weekendRate: number;
  nightStartMinute: number;
  nightEndMinute: number;
  saturdayFromMinute: number;
  surchargeShortTrip: boolean;
  emptyLegRateShort: number;
  emptyLegRateLong: number;
  emptyLegThresholdKm: number;
  sharedDiscounts: readonly SharedDiscount[];
  maxSharedPatients: number;
  aloneDiscount: number;
  aloneThresholdKm: number;
  billableDetourKm: readonly number[];
  tpmrFare: number;
};

export type FareTrip = { bigCity: boolean; agglomeration: boolean; hospitalLinked: boolean; wheelchair: boolean; tollAmount: number };

/** What the invoice reads from the route (see pricing.Ride). */
export type FareRide = {
  directKm: number;
  rideKm: number;
  aloneKm: number;
  coPassengers: number;
  maxOnBoard: number;
  pickupMin: number;
  dropoffMin: number;
  /** The vehicle drives empty to its station after this dropoff, or came empty from it. */
  emptyLeg: boolean;
};

export type FareRules = { emptyLegOrder: "MULTIPLICATIVE" | "ADDITIVE"; patientCount: "DISTINCT" | "MAX_ON_BOARD" };

/** The planned date and the public holidays around it. */
export type FareCalendar = { date: string; holidays: ReadonlySet<string> };

const MONEY = 4;
const RATE = 4;
const KM = 3;
const ONE = 10_000n;
const METERS = 1_000n;
const MINUTES_PER_DAY = 24 * 60;
/** What an invoice total is divided by to give cents: 10^4 (money) x 10^3 (km) x (10^4)^3 / 100. */
const CENTS_DENOMINATOR = 10n ** 17n;

/** `value` x 10^decimals, rounded half up from the shortest writing of `value` (>= 0). */
export function scaledInt(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`Montant invalide\u00a0: ${value}`);
  const [mantissa = "0", exponent] = String(value).toLowerCase().split("e");
  const [whole = "0", fraction = ""] = mantissa.split(".");
  const shift = Number(exponent ?? 0) - fraction.length + decimals;
  const digits = BigInt(whole + fraction);
  if (shift >= 0) return digits * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  return (2n * digits + divisor) / (2n * divisor);
}

const money = (value: number) => scaledInt(value, MONEY);
const rate = (value: number) => scaledInt(value, RATE);
const meters = (km: number) => scaledInt(km, KM);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** Night time of the planned day and the next one, in minutes of the planned day. */
function nightSpans(start: number, end: number): [number, number][] {
  if (start > end) return [0, 1, 2].map((day) => [day * MINUTES_PER_DAY + start - MINUTES_PER_DAY, day * MINUTES_PER_DAY + end]);
  return [0, 1].map((day) => [day * MINUTES_PER_DAY + start, day * MINUTES_PER_DAY + end]);
}

/** More than half of the time from pickup to dropoff falls in the grid's night. */
export function isNight(grid: Pick<FareGrid, "nightStartMinute" | "nightEndMinute">, pickupMin: number, dropoffMin: number): boolean {
  const spans = nightSpans(grid.nightStartMinute, grid.nightEndMinute);
  if (dropoffMin <= pickupMin) return spans.some(([start, end]) => start <= pickupMin && pickupMin < end);
  const night = spans.reduce((sum, [start, end]) => sum + Math.max(0, Math.min(dropoffMin, end) - Math.max(pickupMin, start)), 0);
  return 2 * night > dropoffMin - pickupMin;
}

/** Saturday from `saturdayFromMinute`, Sunday, or a public holiday, at `minute` of the planned day. */
export function isWeekend(calendar: FareCalendar, minute: number, saturdayFromMinute: number): boolean {
  const offset = Math.floor(minute / MINUTES_PER_DAY);
  const day = addDays(calendar.date, offset);
  if (calendar.holidays.has(day)) return true;
  const weekday = isoWeekday(day);
  return weekday === 7 || (weekday === 6 && minute - offset * MINUTES_PER_DAY >= saturdayFromMinute);
}

function billedMeters(grid: FareGrid, ride: FareRide): bigint {
  const direct = meters(ride.directKm);
  if (ride.coPassengers === 0 || grid.billableDetourKm.length === 0) return direct;
  const cap = grid.billableDetourKm.slice(0, ride.coPassengers).reduce((sum, km) => sum + meters(km), 0n);
  return direct + min(max(0n, meters(ride.rideKm) - direct), cap);
}

function discountRate(grid: FareGrid, ride: FareRide, patients: number): bigint {
  if (patients < 2) return 0n;
  if (grid.aloneDiscount > 0 && meters(ride.aloneKm) >= meters(grid.aloneThresholdKm)) return rate(grid.aloneDiscount);
  const counted = Math.min(patients, grid.maxSharedPatients);
  const applicable = grid.sharedDiscounts.filter((d) => d.patients <= counted).sort((a, b) => a.patients - b.patients);
  const last = applicable[applicable.length - 1];
  return last ? rate(last.rate) : 0n;
}

/** One patient's invoice, in cents. */
export function fareCents(
  grid: FareGrid,
  trip: FareTrip,
  vehicle: { tpmrEquipped: boolean },
  ride: FareRide,
  rules: FareRules,
  calendar: FareCalendar,
): number {
  const billed = billedMeters(grid, ride);
  const base = trip.agglomeration && grid.aggloFare !== null ? grid.aggloFare : grid.baseFare;
  const fare = money(base) + (trip.bigCity ? money(grid.bigCityFare) : 0n);
  const perKm = money(grid.pricePerKm);
  const km = max(0n, billed - meters(grid.includedKm));
  const band = grid.shortTripBands.find((b) => billed <= meters(b.upToKm));
  const short = band ? money(band.amount) : 0n;
  let surcharge = 0n;
  if (isNight(grid, ride.pickupMin, ride.dropoffMin)) surcharge = max(surcharge, rate(grid.nightRate));
  if (isWeekend(calendar, ride.pickupMin, grid.saturdayFromMinute)) surcharge = max(surcharge, rate(grid.weekendRate));
  let empty = 0n;
  if (ride.emptyLeg && trip.hospitalLinked) {
    empty = rate(billed >= meters(grid.emptyLegThresholdKm) ? grid.emptyLegRateLong : grid.emptyLegRateShort);
  }
  const patients = rules.patientCount === "MAX_ON_BOARD" ? Math.max(1, ride.maxOnBoard) : 1 + ride.coPassengers;
  const discount = discountRate(grid, ride, patients);

  const fareTerm = fare * METERS * ONE * (ONE + surcharge);
  const kmTerm =
    rules.emptyLegOrder === "ADDITIVE" ? perKm * km * ONE * (ONE + empty + surcharge) : perKm * km * (ONE + empty) * (ONE + surcharge);
  const shortTerm = short * METERS * ONE * (grid.surchargeShortTrip ? ONE + surcharge : ONE);
  const discounted = (fareTerm + kmTerm + shortTerm) * (ONE - discount);
  const tpmr = trip.wheelchair && vehicle.tpmrEquipped ? money(grid.tpmrFare) : 0n;
  const outside = (tpmr + money(trip.tollAmount)) * METERS * ONE ** 3n;
  const total = discounted + outside;
  return Number((2n * total + CENTS_DENOMINATOR) / (2n * CENTS_DENOMINATOR));
}

/** fareCents in euros. */
export function fareEuros(...args: Parameters<typeof fareCents>): number {
  return fareCents(...args) / 100;
}

export const NO_TRIP_FLAGS: FareTrip = { bigCity: false, agglomeration: false, hospitalLinked: false, wheelchair: false, tollAmount: 0 };
export const DEFAULT_FARE_RULES: FareRules = { emptyLegOrder: "MULTIPLICATIVE", patientCount: "DISTINCT" };

/** The company's readings of the conventions (AppSettings), as the optimizer request carries them (settings.pricing). */
export function fareRulesOf(settings: { surchargeOrder: FareRules["emptyLegOrder"]; sharedPatientCount: FareRules["patientCount"] }): FareRules {
  return { emptyLegOrder: settings.surchargeOrder, patientCount: settings.sharedPatientCount };
}

/** A ride of `km` km from `pickupMin`, shared by `patients` patients travelling the same distance together. */
export function sameRide(km: number, patients: number, pickupMin: number, minutes: number): FareRide {
  return {
    directKm: km,
    rideKm: km,
    aloneKm: patients > 1 ? 0 : km,
    coPassengers: patients - 1,
    maxOnBoard: patients,
    pickupMin,
    dropoffMin: pickupMin + minutes,
    emptyLeg: false,
  };
}

/** Day minutes of a ride: about 2 minutes per km, at least 10 (simulator only). */
export function rideMinutes(km: number): number {
  return Math.max(10, Math.round(km * 2));
}

/**
 * Grid without its sharing rows, for a first look (« 2 / 3 / 4 et plus »):
 * the rates of the table for 2, 3, … patients up to `maxSharedPatients`.
 */
export function sharingSteps(grid: Pick<FareGrid, "sharedDiscounts" | "maxSharedPatients">): number[] {
  return Array.from({ length: Math.max(0, Math.min(grid.maxSharedPatients, 4) - 1) }, (_, i) => i + 2);
}
