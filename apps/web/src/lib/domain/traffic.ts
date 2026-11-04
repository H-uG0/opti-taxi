/**
 * Traffic settings: zones and factors per time band (TrafficZone) and peak
 * hours (AppSettings), turned into settings.traffic of the optimizer contract.
 * The formula itself lives in the optimizer (services/optimizer/app/traffic.py,
 * contract/README.md).
 *
 * No server-only import: the seed and the history script share this module.
 */
import type { AppSettings, Prisma, PrismaClient, TrafficZone } from "@prisma/client";
import { isoWeekday } from "@/lib/time";
import type { OptimizerSettings } from "@/lib/optimizer/contract";

export const TRAFFIC_BANDS = ["morning", "day", "evening"] as const;
export type TrafficBandKey = (typeof TRAFFIC_BANDS)[number];

export const TRAFFIC_BAND_LABELS: Record<TrafficBandKey, string> = {
  morning: "Pointe du matin",
  day: "Journée",
  evening: "Pointe du soir",
};

/** The zone column holding the factor of each band. */
export const FACTOR_FIELDS = {
  morning: "morningFactor",
  day: "dayFactor",
  evening: "eveningFactor",
} as const satisfies Record<TrafficBandKey, keyof TrafficZone>;

/** A factor makes a leg slower, never faster than free flow. */
export const MIN_TRAFFIC_FACTOR = 1;
export const MAX_TRAFFIC_FACTOR = 3;

/**
 * Starting values, not measurements: to calibrate on real driving times (see
 * traffic-observed.ts). Only the agglomerations where traffic weighs on the
 * Marseille – Grenoble axis have a zone.
 */
const DEFAULT_ZONES: Prisma.TrafficZoneCreateManyInput[] = [
  { name: "Marseille", position: 1, lat: 43.2965, lng: 5.3698, radiusKm: 14, morningFactor: 1.5, dayFactor: 1.2, eveningFactor: 1.5 },
  { name: "Aix-en-Provence", position: 2, lat: 43.5297, lng: 5.4474, radiusKm: 8, morningFactor: 1.35, dayFactor: 1.1, eveningFactor: 1.35 },
  { name: "Grenoble", position: 3, lat: 45.1885, lng: 5.7245, radiusKm: 10, morningFactor: 1.4, dayFactor: 1.15, eveningFactor: 1.4 },
  { name: "Hors agglomération", position: 4, lat: null, lng: null, radiusKm: null, morningFactor: 1.05, dayFactor: 1, eveningFactor: 1.05 },
];

/** Zones in display order; the default ones are created on first read (like the settings row). */
export async function loadTrafficZones(prisma: PrismaClient): Promise<TrafficZone[]> {
  const zones = await prisma.trafficZone.findMany({ orderBy: { position: "asc" } });
  if (zones.length > 0) return zones;
  await prisma.trafficZone.createMany({ data: DEFAULT_ZONES, skipDuplicates: true });
  return prisma.trafficZone.findMany({ orderBy: { position: "asc" } });
}

export type TrafficPeaks = Pick<
  AppSettings,
  "morningPeakStartMinute" | "morningPeakEndMinute" | "eveningPeakStartMinute" | "eveningPeakEndMinute"
>;

export type TrafficInput = TrafficPeaks &
  Pick<AppSettings, "trafficEnabled"> & {
    zones: Pick<TrafficZone, "lat" | "lng" | "radiusKm" | "morningFactor" | "dayFactor" | "eveningFactor">[];
  };

/** [start, end) of each band: the day runs between the two peaks. */
export function bandRanges(peaks: TrafficPeaks): Record<TrafficBandKey, { start: number; end: number }> {
  return {
    morning: { start: peaks.morningPeakStartMinute, end: peaks.morningPeakEndMinute },
    day: { start: peaks.morningPeakEndMinute, end: peaks.eveningPeakStartMinute },
    evening: { start: peaks.eveningPeakStartMinute, end: peaks.eveningPeakEndMinute },
  };
}

/** Weekend: no commuter peak, the whole span from morning to evening takes the day factors. */
export function isPeakDay(isoDate: string): boolean {
  return isoWeekday(isoDate) <= 5;
}

/** settings.traffic of a request for `isoDate`; undefined when traffic is switched off. */
export function toContractTraffic(input: TrafficInput, isoDate: string): OptimizerSettings["traffic"] {
  if (!input.trafficEnabled) return undefined;
  const ranges = bandRanges(input);
  const keys: readonly TrafficBandKey[] = isPeakDay(isoDate) ? TRAFFIC_BANDS : ["day"];
  const bands = isPeakDay(isoDate)
    ? keys.map((key) => ({ startMin: ranges[key].start, endMin: ranges[key].end }))
    : [{ startMin: ranges.morning.start, endMin: ranges.evening.end }];
  const factors = (zone: TrafficInput["zones"][number]) => keys.map((key) => zone[FACTOR_FIELDS[key]]);
  const road = input.zones.find((zone) => zone.radiusKm === null);
  return {
    bands,
    roadFactors: road ? factors(road) : keys.map(() => 1),
    zones: input.zones.flatMap((zone) =>
      zone.lat !== null && zone.lng !== null && zone.radiusKm !== null
        ? [{ lat: zone.lat, lng: zone.lng, radiusKm: zone.radiusKm, factors: factors(zone) }]
        : [],
    ),
  };
}
