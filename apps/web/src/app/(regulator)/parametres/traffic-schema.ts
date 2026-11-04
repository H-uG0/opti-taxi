/**
 * Traffic settings form: peak hours (AppSettings), and factors and radius of
 * each zone (TrafficZone). The list of zones comes from the database, so the
 * schema is built for it. Pure module, unit-tested.
 */
import { z } from "zod";
import type { AppSettings, TrafficZone } from "@prisma/client";
import {
  FACTOR_FIELDS,
  MAX_TRAFFIC_FACTOR,
  MIN_TRAFFIC_FACTOR,
  TRAFFIC_BANDS,
  type TrafficBandKey,
} from "@/lib/domain/traffic";
import { formatDecimalInput, numberField, timeField, type FormState, type FormValues } from "@/lib/forms";
import { formatMinute } from "@/lib/time";

export const MAX_ZONE_RADIUS_KM = 50;

export function factorField(zoneId: string, band: TrafficBandKey): string {
  return `zone-${zoneId}-${band}`;
}

export function radiusField(zoneId: string): string {
  return `zone-${zoneId}-radius`;
}

type ZoneRef = Pick<TrafficZone, "id" | "radiusKm">;

export function trafficSchema(zones: readonly ZoneRef[]) {
  const shape: Record<string, z.ZodType> = {
    trafficEnabled: z.preprocess((value) => value === "on", z.boolean()),
    morningPeakStart: timeField(),
    morningPeakEnd: timeField(),
    eveningPeakStart: timeField(),
    eveningPeakEnd: timeField(),
  };
  for (const zone of zones) {
    for (const band of TRAFFIC_BANDS) {
      shape[factorField(zone.id, band)] = numberField({ min: MIN_TRAFFIC_FACTOR, max: MAX_TRAFFIC_FACTOR });
    }
    if (zone.radiusKm !== null) shape[radiusField(zone.id)] = numberField({ min: 1, max: MAX_ZONE_RADIUS_KM, unit: "km" });
  }
  return z.object(shape).superRefine((v, ctx) => {
    const [morningStart, morningEnd, eveningStart, eveningEnd] = [v.morningPeakStart, v.morningPeakEnd, v.eveningPeakStart, v.eveningPeakEnd].map(Number);
    if (morningStart === undefined || morningEnd === undefined || eveningStart === undefined || eveningEnd === undefined) return;
    if (morningEnd <= morningStart) {
      ctx.addIssue({ code: "custom", path: ["morningPeakEnd"], message: "La fin de la pointe doit être après son début." });
    } else if (eveningStart <= morningEnd) {
      ctx.addIssue({
        code: "custom",
        path: ["eveningPeakStart"],
        message: `La pointe du soir doit commencer après celle du matin (${formatMinute(morningEnd)}).`,
      });
    } else if (eveningEnd <= eveningStart) {
      ctx.addIssue({ code: "custom", path: ["eveningPeakEnd"], message: "La fin de la pointe doit être après son début." });
    }
  });
}

export type TrafficUpdate = {
  settings: Pick<
    AppSettings,
    "trafficEnabled" | "morningPeakStartMinute" | "morningPeakEndMinute" | "eveningPeakStartMinute" | "eveningPeakEndMinute"
  >;
  zones: Array<{ id: string; radiusKm: number | null; morningFactor: number; dayFactor: number; eveningFactor: number }>;
};

/** The validated form (trafficSchema output) as database values. */
export function toTrafficUpdate(values: Record<string, unknown>, zones: readonly ZoneRef[]): TrafficUpdate {
  return {
    settings: {
      trafficEnabled: values.trafficEnabled === true,
      morningPeakStartMinute: Number(values.morningPeakStart),
      morningPeakEndMinute: Number(values.morningPeakEnd),
      eveningPeakStartMinute: Number(values.eveningPeakStart),
      eveningPeakEndMinute: Number(values.eveningPeakEnd),
    },
    zones: zones.map((zone) => ({
      id: zone.id,
      radiusKm: zone.radiusKm === null ? null : Number(values[radiusField(zone.id)]),
      morningFactor: Number(values[factorField(zone.id, "morning")]),
      dayFactor: Number(values[factorField(zone.id, "day")]),
      eveningFactor: Number(values[factorField(zone.id, "evening")]),
    })),
  };
}

type StoredZone = ZoneRef & Pick<TrafficZone, "morningFactor" | "dayFactor" | "eveningFactor">;

/** Whether the update changes the planned times: plans computed before it stop counting for the calibration. */
export function trafficChanged(settings: TrafficUpdate["settings"], zones: readonly StoredZone[], update: TrafficUpdate): boolean {
  const fields = Object.keys(update.settings) as (keyof TrafficUpdate["settings"])[];
  if (fields.some((field) => settings[field] !== update.settings[field])) return true;
  return update.zones.some((next) => {
    const zone = zones.find((candidate) => candidate.id === next.id);
    return (
      !zone ||
      zone.radiusKm !== next.radiusKm ||
      TRAFFIC_BANDS.some((band) => zone[FACTOR_FIELDS[band]] !== next[FACTOR_FIELDS[band]])
    );
  });
}

/**
 * What the form shows after its two actions: the last response speaks. Observed
 * values just applied replace what was typed before: saving those would undo them.
 */
export function trafficFormView(saved: FormState, applied: FormState, stored: FormValues) {
  const appliedLast = applied.submissionId > saved.submissionId;
  const overwritten = appliedLast && applied.status === "success";
  return {
    response: appliedLast ? applied : saved,
    values: overwritten ? stored : (saved.values ?? stored),
    errors: overwritten ? {} : saved.fieldErrors,
  };
}

export function trafficFormValues(settings: TrafficUpdate["settings"], zones: readonly StoredZone[]): FormValues {
  const values: FormValues = {
    morningPeakStart: formatMinute(settings.morningPeakStartMinute),
    morningPeakEnd: formatMinute(settings.morningPeakEndMinute),
    eveningPeakStart: formatMinute(settings.eveningPeakStartMinute),
    eveningPeakEnd: formatMinute(settings.eveningPeakEndMinute),
  };
  if (settings.trafficEnabled) values.trafficEnabled = "on";
  for (const zone of zones) {
    for (const band of TRAFFIC_BANDS) values[factorField(zone.id, band)] = formatDecimalInput(zone[FACTOR_FIELDS[band]]);
    if (zone.radiusKm !== null) values[radiusField(zone.id)] = formatDecimalInput(zone.radiusKm);
  }
  return values;
}
