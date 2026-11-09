/**
 * What the roadmap says about the driver's session: « Session valable
 * jusqu'à HH:MM » at the bottom of the page, a warning in the header 30 min
 * before the end (the session renews itself sooner whenever the app reaches the
 * server: if it is still close to its end, the phone has had no network), and
 * « Session expirée » once over. Pure module (unit-tested).
 */
import { formatMinute, isoDateOf, minuteOfDay, addDays } from "@/lib/time";

export const SESSION_WARNING_MS = 30 * 60 * 1000;

export type SessionNotice =
  /** Unknown end (not read yet). */
  | { kind: "unknown" }
  | { kind: "valid"; until: string }
  | { kind: "ending"; until: string; minutesLeft: number }
  | { kind: "expired" };

/** "17:30" the same day, "demain 05:12" the next one (Europe/Paris). */
export function formatSessionEnd(expiresAt: Date, now: Date): string {
  const time = formatMinute(minuteOfDay(expiresAt));
  const day = isoDateOf(expiresAt);
  if (day === isoDateOf(now)) return time;
  if (day === addDays(isoDateOf(now), 1)) return `demain ${time}`;
  return `${day.slice(8, 10)}/${day.slice(5, 7)} ${time}`;
}

/** `lost`: the server already answered that the session is over (401). */
export function sessionNotice(expiresAt: number | null, now: number, lost: boolean): SessionNotice {
  if (lost) return { kind: "expired" };
  if (expiresAt === null || !Number.isFinite(expiresAt)) return { kind: "unknown" };
  const left = expiresAt - now;
  if (left <= 0) return { kind: "expired" };
  const until = formatSessionEnd(new Date(expiresAt), new Date(now));
  if (left <= SESSION_WARNING_MS) return { kind: "ending", until, minutesLeft: Math.max(1, Math.ceil(left / 60_000)) };
  return { kind: "valid", until };
}
