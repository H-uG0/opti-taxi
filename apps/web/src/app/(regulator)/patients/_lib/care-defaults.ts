/**
 * « Nouveau patient régulier »: the rhythm proposed once the care facility is
 * chosen, by its type — dialysis on Monday, Wednesday and Friday for 4 h,
 * radiotherapy every weekday —, and the prescription's defaults. Fields the
 * regulator already filled are never overwritten. Pure.
 */
import type { FacilityType, Mobility, PrescribedMode, SharingScope } from "@prisma/client";
import { addDays } from "@/lib/time";

export type CareDefaults = { label: string; weekdays: readonly number[] | null; sessionMinutes: number | null };

/**
 * Usual rhythm of a treatment. Radiotherapy: 30 min from the appointment to
 * the return pickup (session and dressing room); chemotherapy only names the
 * treatment (cycles and session lengths vary too much to guess).
 */
export const CARE_DEFAULTS: Partial<Record<FacilityType, CareDefaults>> = {
  DIALYSIS: { label: "Dialyse", weekdays: [1, 3, 5], sessionMinutes: 240 },
  RADIOTHERAPY: { label: "Radiothérapie", weekdays: [1, 2, 3, 4, 5], sessionMinutes: 30 },
  CHEMOTHERAPY: { label: "Chimiothérapie", weekdays: null, sessionMinutes: null },
};

export type RhythmValues = { label: string; weekdays: readonly string[]; sessionMinutes: string };

/**
 * The rhythm once a facility of `type` is chosen: each field still empty takes
 * the default of the treatment (a label typed, a day ticked or a duration
 * typed stays as it is). A label that was itself a default follows the new type.
 */
export function withCareDefaults(current: RhythmValues, type: FacilityType | null, previousType: FacilityType | null = null): RhythmValues {
  const defaults = type ? CARE_DEFAULTS[type] : undefined;
  const previous = previousType ? CARE_DEFAULTS[previousType] : undefined;
  const labelIsDefault = current.label.trim() === "" || (previous !== undefined && current.label === previous.label);
  const daysAreDefault =
    current.weekdays.length === 0 ||
    (previous?.weekdays != null && sameDays(current.weekdays, previous.weekdays));
  const sessionIsDefault =
    current.sessionMinutes.trim() === "" || (previous?.sessionMinutes != null && current.sessionMinutes === String(previous.sessionMinutes));
  return {
    label: labelIsDefault ? (defaults?.label ?? (previous ? "" : current.label)) : current.label,
    weekdays: daysAreDefault ? (defaults?.weekdays?.map(String) ?? (previous ? [] : current.weekdays)) : current.weekdays,
    sessionMinutes: sessionIsDefault
      ? defaults?.sessionMinutes != null
        ? String(defaults.sessionMinutes)
        : previous
          ? ""
          : current.sessionMinutes
      : current.sessionMinutes,
  };
}

function sameDays(a: readonly string[], b: readonly number[]): boolean {
  const left = [...a].map(Number).sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  return left.length === right.length && left.every((d, i) => d === right[i]);
}

/** The prescribed mode a mobility calls for: lying → ambulance; seated or wheelchair → TAP (taxi or VSL). */
export function defaultMode(mobility: Mobility): PrescribedMode {
  return mobility === "LYING" ? "AMBULANCE" : "TAP";
}

/** Sharing proposed with a mode: allowed both ways for TAP (the prescriber may restrict it), never in an ambulance. */
export function defaultSharing(mode: PrescribedMode): SharingScope {
  return mode === "AMBULANCE" ? "NONE" : "BOTH";
}

/** « 3 mois », « 6 mois », « 1 an »: end of validity from its start (the day before the same date N months later). */
export const VALIDITY_SHORTCUTS = [
  { label: "3 mois", months: 3 },
  { label: "6 mois", months: 6 },
  { label: "1 an", months: 12 },
] as const;

export function validityEnd(validFromIso: string, months: number): string {
  const [year, month, day] = validFromIso.split("-").map(Number) as [number, number, number];
  const targetMonth = month - 1 + months;
  const y = year + Math.floor(targetMonth / 12);
  const m = targetMonth % 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const same = `${y}-${String(m + 1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
  return addDays(same, -1);
}
