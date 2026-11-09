/**
 * Calibration of the traffic factors on real driving times: the app already
 * records when the crew taps « pris en charge » and « déposé » (RouteStop
 * .completedAt), so each loaded leg compares a planned drive with a real one.
 * The factor that fits is the factor applied when the plan was computed, times
 * the median real / planned ratio.
 *
 * A tap does not mark the same moment at every stop: « pris en charge » is
 * tapped with the patient on board (end of the stop), « déposé » on arrival
 * (start of the stop). The time spent at a stop between two taps is taken out.
 *
 * Which legs count:
 * - a patient on board and no planned wait at the next stop: the vehicle drove
 *   straight there, so the time between the two taps is a driving time;
 * - both ends inside one zone (its factor applies to the whole leg), or a leg
 *   that stays out of every zone (the road factor); legs entering, leaving or
 *   crossing a zone are left out, since their factor covers only part of the
 *   drive;
 * - working days only, well inside one time band: the plan took the band from
 *   the reference minutes of the two stops (optimizer: traffic.py), not from the
 *   planned times, so next to a band edge the factor it applied is not known;
 * - computed since the last change of the traffic settings (older plans used
 *   other factors);
 * - computed with the distance source of the latest run (Route.matrixSource,
 *   OSRM or the straight-line estimate): a day planned on the fallback would
 *   teach its error as traffic. A route recomputed (/evaluate) with another
 *   source than its own is left out (MIXED_MATRIX_SOURCE).
 *
 * Nothing changes by itself: the regulator applies the values shown in
 * /parametres. No server-only import: unit-tested.
 */
import type { AppSettings, Prisma, PrismaClient, StopKind, TrafficZone } from "@prisma/client";
import { addDays, fromIsoDate, todayIso, toIsoDate } from "@/lib/time";
import {
  bandRanges,
  FACTOR_FIELDS,
  isPeakDay,
  MAX_TRAFFIC_FACTOR,
  MIN_TRAFFIC_FACTOR,
  TRAFFIC_BANDS,
  type TrafficBandKey,
  type TrafficPeaks,
} from "./traffic";

/** Below this many legs, a median says more about one driver's day than about the traffic. */
export const MIN_OBSERVED_LEGS = 20;
const OBSERVATION_DAYS = 56;
/** Shorter drives are mostly the imprecision of a tap on a phone. */
const MIN_PLANNED_MINUTES = 5;
/** A ratio outside these bounds is a forgotten tap, not traffic. */
const MIN_RATIO = 0.3;
const MAX_RATIO = 4;
const FACTOR_STEP = 0.05;
/** How far a planned stop can be from its reference minute: the wait allowed at the facility. */
const REFERENCE_DRIFT_MINUTES = 45;
const KM_PER_DEGREE = (Math.PI * 6371) / 180;

export type ObservedStop = {
  routeId: string;
  sequence: number;
  kind: StopKind;
  lat: number;
  lng: number;
  arrivalMinute: number;
  startMinute: number;
  departureMinute: number;
  loadAfter: number;
  completedAt: Date | null;
  route: { serviceDate: Date };
};

export type ObservedLeg = {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  isoDate: string;
  departureMinute: number;
  plannedMinutes: number;
  actualMinutes: number;
};

/** Driving legs of stops sorted by route then sequence (see the module comment). */
export function legsFromStops(stops: readonly ObservedStop[]): ObservedLeg[] {
  const legs: ObservedLeg[] = [];
  for (let i = 1; i < stops.length; i++) {
    const previous = stops[i - 1];
    const stop = stops[i];
    if (!previous || !stop || previous.routeId !== stop.routeId || stop.sequence !== previous.sequence + 1) continue;
    if (!previous.completedAt || !stop.completedAt) continue;
    if (previous.loadAfter === 0 || stop.arrivalMinute !== stop.startMinute) continue;
    // The stop's duration lies between the taps after a dropoff (tapped at its start) and before a pickup (tapped at its end).
    const atPrevious = previous.kind === "DROPOFF" ? previous.departureMinute - previous.startMinute : 0;
    const atStop = stop.kind === "PICKUP" ? stop.departureMinute - stop.startMinute : 0;
    legs.push({
      from: { lat: previous.lat, lng: previous.lng },
      to: { lat: stop.lat, lng: stop.lng },
      isoDate: toIsoDate(stop.route.serviceDate),
      departureMinute: previous.departureMinute,
      plannedMinutes: stop.arrivalMinute - previous.departureMinute,
      actualMinutes: (stop.completedAt.getTime() - previous.completedAt.getTime()) / 60_000 - atPrevious - atStop,
    });
  }
  return legs;
}

type ZoneInput = Pick<TrafficZone, "id" | "lat" | "lng" | "radiusKm" | "morningFactor" | "dayFactor" | "eveningFactor">;
type LatLng = { lat: number; lng: number };
type Circle = ZoneInput & LatLng & { radiusKm: number };

function isCircle(zone: ZoneInput): zone is Circle {
  return zone.lat !== null && zone.lng !== null && zone.radiusKm !== null;
}

/** Whether the straight segment a-b passes inside the circle (flat earth around its center, like the optimizer). */
function touches(a: LatLng, b: LatLng, zone: Circle): boolean {
  const xScale = KM_PER_DEGREE * Math.cos((zone.lat * Math.PI) / 180);
  const ax = (a.lng - zone.lng) * xScale;
  const ay = (a.lat - zone.lat) * KM_PER_DEGREE;
  const dx = (b.lng - zone.lng) * xScale - ax;
  const dy = (b.lat - zone.lat) * KM_PER_DEGREE - ay;
  const squared = dx * dx + dy * dy;
  const closest = squared === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / squared));
  return Math.hypot(ax + closest * dx, ay + closest * dy) <= zone.radiusKm;
}

/** The zone a leg speaks for: both ends in it, or the road row when it stays out of every zone. */
function legZone(leg: ObservedLeg, zones: readonly ZoneInput[]): ZoneInput | null {
  const circles = zones.filter(isCircle);
  const from = circles.find((zone) => touches(leg.from, leg.from, zone));
  const to = circles.find((zone) => touches(leg.to, leg.to, zone));
  if (from || to) return from?.id === to?.id ? (from ?? null) : null;
  if (circles.some((zone) => touches(leg.from, leg.to, zone))) return null;
  return zones.find((zone) => !isCircle(zone)) ?? null;
}

function bandOf(minute: number, peaks: TrafficPeaks): TrafficBandKey | null {
  const ranges = bandRanges(peaks);
  return TRAFFIC_BANDS.find((band) => minute >= ranges[band].start && minute < ranges[band].end) ?? null;
}

/** The band of a leg when both its reference minutes must lie in it, else null (see the module comment). */
function bandOfLeg(leg: ObservedLeg, peaks: TrafficPeaks): TrafficBandKey | null {
  const first = bandOf(leg.departureMinute - REFERENCE_DRIFT_MINUTES, peaks);
  const last = bandOf(leg.departureMinute + leg.plannedMinutes + REFERENCE_DRIFT_MINUTES, peaks);
  return first === last ? first : null;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  const high = sorted[Math.floor(middle)] ?? 1;
  return sorted.length % 2 === 1 ? high : ((sorted[middle - 1] ?? high) + high) / 2;
}

export type ObservedFactor = {
  zoneId: string;
  band: TrafficBandKey;
  /** Legs measured for this zone and band. */
  legs: number;
  /** Factor that fits them, null below MIN_OBSERVED_LEGS. */
  factor: number | null;
};

export function observedFactors(
  legs: readonly ObservedLeg[],
  zones: readonly ZoneInput[],
  settings: TrafficPeaks & Pick<AppSettings, "trafficEnabled">,
): ObservedFactor[] {
  const ratios = new Map<string, number[]>();
  for (const leg of legs) {
    if (!isPeakDay(leg.isoDate) || leg.plannedMinutes < MIN_PLANNED_MINUTES) continue;
    const ratio = leg.actualMinutes / leg.plannedMinutes;
    if (ratio < MIN_RATIO || ratio > MAX_RATIO) continue;
    const band = bandOfLeg(leg, settings);
    const zone = legZone(leg, zones);
    if (!band || !zone) continue;
    const key = `${zone.id}/${band}`;
    ratios.set(key, [...(ratios.get(key) ?? []), ratio]);
  }
  return zones.flatMap((zone) =>
    TRAFFIC_BANDS.map((band) => {
      const measured = ratios.get(`${zone.id}/${band}`) ?? [];
      // Plans computed with traffic switched off used free-flow times: factor 1.
      const applied = settings.trafficEnabled ? zone[FACTOR_FIELDS[band]] : MIN_TRAFFIC_FACTOR;
      const fitted = Math.round((applied * median(measured)) / FACTOR_STEP) * FACTOR_STEP;
      const factor = Math.min(MAX_TRAFFIC_FACTOR, Math.max(MIN_TRAFFIC_FACTOR, Math.round(fitted * 100) / 100));
      return { zoneId: zone.id, band, legs: measured.length, factor: measured.length >= MIN_OBSERVED_LEGS ? factor : null };
    }),
  );
}

/** Routes of the calibration period: recent, planned since the last change of the traffic settings. */
function calibrationPeriod(settings: Pick<AppSettings, "trafficChangedAt">, now: Date): Prisma.RouteWhereInput {
  return {
    serviceDate: { gte: fromIsoDate(addDays(todayIso(now), -OBSERVATION_DAYS)) },
    // startedAt: the settings are read when the run starts.
    ...(settings.trafficChangedAt ? { optimizationRun: { startedAt: { gte: settings.trafficChangedAt } } } : {}),
  };
}

/** Routes whose recorded stops count: those of the calibration period planned with `source`. */
export function calibrationRoutes(
  settings: Pick<AppSettings, "trafficChangedAt">,
  source: string | null,
  now: Date,
): Prisma.RouteWhereInput {
  // No run yet: nothing to calibrate on (a route has no source before its first run).
  return { ...calibrationPeriod(settings, now), matrixSource: source ?? "" };
}

/** Source of the distances of the latest finished run (osrm, haversine): what the factors apply to. */
export async function currentMatrixSource(prisma: Pick<PrismaClient, "optimizationRun">): Promise<string | null> {
  const run = await prisma.optimizationRun.findFirst({
    where: { status: "SUCCESS", matrixSource: { not: null } },
    orderBy: { startedAt: "desc" },
    select: { matrixSource: true },
  });
  return run?.matrixSource ?? null;
}

export type ObservedCalibration = {
  /** Distance source of the routes measured, null before any run. */
  source: string | null;
  factors: ObservedFactor[];
  /** Routes with recorded stops in the same period, left out because planned with another source. */
  otherSourceRoutes: number;
};

export async function loadObservedCalibration(
  prisma: PrismaClient,
  settings: TrafficPeaks & Pick<AppSettings, "trafficEnabled" | "trafficChangedAt">,
  zones: readonly ZoneInput[],
  now: Date = new Date(),
): Promise<ObservedCalibration> {
  const source = await currentMatrixSource(prisma);
  const [factors, others] = await Promise.all([
    observedFactorsOf(prisma, settings, zones, calibrationRoutes(settings, source, now)),
    prisma.route.count({
      where: {
        ...calibrationPeriod(settings, now),
        // A route of unknown source (its run deleted) counts as another source.
        OR: [{ matrixSource: null }, { NOT: { matrixSource: source ?? "" } }],
        stops: { some: { completedAt: { not: null } } },
      },
    }),
  ]);
  return { source, factors, otherSourceRoutes: others };
}

export async function loadObservedFactors(
  prisma: PrismaClient,
  settings: TrafficPeaks & Pick<AppSettings, "trafficEnabled" | "trafficChangedAt">,
  zones: readonly ZoneInput[],
  now: Date = new Date(),
): Promise<ObservedFactor[]> {
  return (await loadObservedCalibration(prisma, settings, zones, now)).factors;
}

async function observedFactorsOf(
  prisma: PrismaClient,
  settings: TrafficPeaks & Pick<AppSettings, "trafficEnabled">,
  zones: readonly ZoneInput[],
  route: Prisma.RouteWhereInput,
): Promise<ObservedFactor[]> {
  const stops = await prisma.routeStop.findMany({
    where: {
      completedAt: { not: null },
      trip: { status: { notIn: ["NO_SHOW", "CANCELLED"] } },
      route,
    },
    select: {
      routeId: true,
      sequence: true,
      kind: true,
      lat: true,
      lng: true,
      arrivalMinute: true,
      startMinute: true,
      departureMinute: true,
      loadAfter: true,
      completedAt: true,
      route: { select: { serviceDate: true } },
    },
    orderBy: [{ routeId: "asc" }, { sequence: "asc" }],
  });
  return observedFactors(legsFromStops(stops), zones, settings);
}
