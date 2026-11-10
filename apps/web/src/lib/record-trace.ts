/**
 * Who recorded a fact (a patient's answer to shared transport, a stop status)
 * and when, worded the same way on /courses and /planning.
 * Pure (formatted on the server, Europe/Paris): no server-only import so
 * vitest can cover it.
 */
import type { SharingStatus } from "@prisma/client";
import { formatDateTime } from "@/lib/time";

/** A recorded fact, as a full sentence (details panel) and a short form (table row). */
export type RecordTrace = {
  /** "Refus enregistré par Marie Durand le 03/11 à 08:12" */
  full: string;
  /** "par Marie Durand · 03/11 à 08:12", under the badge of the answer or status. */
  short: string;
};

/** Shown when the account is unknown: recorded before the author was traced, or the account was deleted. */
export const UNKNOWN_AUTHOR = "auteur non tracé";

/** "<what> par <name> le 03/11 à 08:12". */
export function recordTrace(what: string, at: Date, byName: string | null | undefined): RecordTrace {
  const when = formatDateTime(at);
  const name = byName?.trim() || null;
  return {
    full: name ? `${what} par ${name} le ${when}` : `${what} le ${when} (${UNKNOWN_AUTHOR})`,
    short: `${name ? `par ${name}` : UNKNOWN_AUTHOR} · ${when}`,
  };
}

/**
 * Words of the patient's current answer to shared transport, or null for any
 * other status, even when an earlier answer left its time: an acceptance reset
 * by a prescription change (NOT_ELIGIBLE, then NOT_PROPOSED or a new PROPOSED)
 * is no answer to the current proposal, and must not read as one. A refusal is
 * never reset (see patients/_lib/trip-sync).
 */
export function sharingAnswerWords(status: SharingStatus): string | null {
  if (status === "REFUSED") return "Refus enregistré";
  if (status === "ACCEPTED") return "Acceptation enregistrée";
  return null;
}
