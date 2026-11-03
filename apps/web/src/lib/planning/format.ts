/** Compact French formatters for the planning screen (complements @/lib/labels). */
import type { SharingStatus, StopKind, TripStatus } from "@prisma/client";
import { recordTrace, sharingAnswerWords, UNKNOWN_AUTHOR } from "@/lib/record-trace";
import { isoDateOf, TIME_ZONE } from "@/lib/time";
import type { RecordedByView } from "./types";

const euros0 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const decimal1 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

/** 3120.5 -> "3 121 €". */
export function formatEurosRounded(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : euros0.format(value);
}

/** 152.34 -> "152 km". */
export function formatKmRounded(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${integer.format(value)} km`;
}

/** 6.444 -> "6,4". */
export function formatDecimal(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : decimal1.format(value);
}

/** 9840 -> "9,8 s"; 72000 -> "1 min 12 s". */
export function formatSeconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const seconds = ms / 1000;
  if (seconds < 60) return `${decimal1.format(seconds)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, "0")} s`;
}

/** ISO instant -> "02/11 à 18:40" in Europe/Paris. */
export function formatInstant(iso: string): string {
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat("fr-FR", { timeZone: TIME_ZONE, day: "2-digit", month: "2-digit" }).format(date);
  const time = new Intl.DateTimeFormat("fr-FR", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit" }).format(date);
  return `${day} à ${time}`;
}

const clock = new Intl.DateTimeFormat("fr-FR", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit" });

/** ISO instant -> "08:12" when it falls on isoDate in Europe/Paris, else "02/11 à 18:40". */
export function formatTimeOn(iso: string, isoDate: string): string {
  const date = new Date(iso);
  return isoDateOf(date) === isoDate ? clock.format(date) : formatInstant(iso);
}

export { UNKNOWN_AUTHOR } from "@/lib/record-trace";

/** "par Marie Durand", or UNKNOWN_AUTHOR. */
export function recordedByText(byName: string | null): string {
  return byName ? `par ${byName}` : UNKNOWN_AUTHOR;
}

/**
 * Trace of the patient's sharing answer, worded as on /courses (@/lib/record-trace):
 * "Refus enregistré par Marie Durand le 02/11 à 18:40", or
 * "Refus enregistré le 02/11 à 18:40 (auteur non tracé)". Null when the
 * status is no answer to the current proposal (reset by a prescription change).
 */
export function sharingAnswerText(answer: RecordedByView, status: SharingStatus): string | null {
  const what = sharingAnswerWords(status);
  return what ? recordTrace(what, new Date(answer.at), answer.byName).full : null;
}

/**
 * What a recorded stop status means, worded as on /courses (record-trace):
 * on a pick-up stop of an absent patient, the absence.
 */
export function fieldRecordLabel(kind: StopKind, tripStatus: TripStatus): string {
  if (kind === "DROPOFF") return "Dépose enregistrée";
  return tripStatus === "NO_SHOW" ? "Absence enregistrée" : "Prise en charge enregistrée";
}

/** "par Jean Martin · 08:12", author first as on /courses (with the day when recorded on another day than isoDate). */
export function fieldRecordText(record: RecordedByView, isoDate: string): string {
  return `${recordedByText(record.byName)} · ${formatTimeOn(record.at, isoDate)}`;
}

/** "2026-11-03" -> "03/11". */
export function formatDayMonth(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${day}/${month}`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count > 1 ? plural : singular}`;
}
