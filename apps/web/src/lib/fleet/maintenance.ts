/**
 * Maintenance deadlines of a vehicle (inspection, service, tyres, insurance…),
 * due at a date, at a mileage, or at the first of the two: their status and
 * the alerts shown in the fleet screens. Pure module.
 */
import type { MaintenanceKind } from "@prisma/client";
import { MAINTENANCE_KIND_LABELS } from "@/lib/labels";
import { addDays, formatShortDate } from "@/lib/time";

/** A deadline within this many days is "soon". */
export const SOON_DAYS = 30;
/** A deadline within this many km of the last odometer reading is "soon". */
export const SOON_KM = 1000;

export type Deadline = {
  kind: MaintenanceKind;
  label: string | null;
  dueDate: string | null;
  dueKm: number | null;
  doneDate: string | null;
};

export type DeadlineStatus = "done" | "overdue" | "soon" | "ok";

export type DeadlineState = { status: DeadlineStatus; text: string };

const nf = new Intl.NumberFormat("fr-FR");

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function deadlineName(d: Pick<Deadline, "kind" | "label">): string {
  return d.label ? `${MAINTENANCE_KIND_LABELS[d.kind]} (${d.label})` : MAINTENANCE_KIND_LABELS[d.kind];
}

/**
 * Status of a deadline on `today`, given the last known odometer (null when
 * no reading: the mileage part is then unknown and ignored). The worst of the
 * date and mileage parts wins.
 */
export function deadlineState(d: Deadline, today: string, odometerKm: number | null): DeadlineState {
  if (d.doneDate) return { status: "done", text: `Fait le ${formatShortDate(d.doneDate)}` };
  const parts: { status: DeadlineStatus; text: string }[] = [];
  if (d.dueDate) {
    const days = daysBetween(today, d.dueDate);
    if (days < 0) parts.push({ status: "overdue", text: `Dépassée depuis le ${formatShortDate(d.dueDate)}` });
    else if (days === 0) parts.push({ status: "soon", text: "Aujourd'hui" });
    else if (d.dueDate <= addDays(today, SOON_DAYS)) parts.push({ status: "soon", text: `Dans ${days} j (${formatShortDate(d.dueDate)})` });
    else parts.push({ status: "ok", text: `Le ${formatShortDate(d.dueDate)}` });
  }
  if (d.dueKm !== null) {
    if (odometerKm === null) parts.push({ status: "ok", text: `À ${nf.format(d.dueKm)} km (compteur inconnu)` });
    else if (odometerKm >= d.dueKm) parts.push({ status: "overdue", text: `Dépassée : ${nf.format(odometerKm)} km pour ${nf.format(d.dueKm)} km` });
    else if (d.dueKm - odometerKm <= SOON_KM) parts.push({ status: "soon", text: `Dans ${nf.format(d.dueKm - odometerKm)} km` });
    else parts.push({ status: "ok", text: `À ${nf.format(d.dueKm)} km` });
  }
  if (parts.length === 0) return { status: "ok", text: "Sans date ni kilométrage" };
  const rank: Record<DeadlineStatus, number> = { overdue: 0, soon: 1, ok: 2, done: 3 };
  const worst = parts.reduce((a, b) => (rank[b.status] < rank[a.status] ? b : a));
  return { status: worst.status, text: parts.map((p) => p.text).join(" · ") };
}

/** Open deadlines needing attention (overdue first, then soon), with their state. */
export function deadlineAlerts<T extends Deadline>(
  deadlines: readonly T[],
  today: string,
  odometerKm: number | null,
): { deadline: T; state: DeadlineState }[] {
  return deadlines
    .map((deadline) => ({ deadline, state: deadlineState(deadline, today, odometerKm) }))
    .filter((a) => a.state.status === "overdue" || a.state.status === "soon")
    .sort((a, b) => (a.state.status === b.state.status ? 0 : a.state.status === "overdue" ? -1 : 1));
}
