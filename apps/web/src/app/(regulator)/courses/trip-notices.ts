/**
 * The banner of « Courses » after « Nouvelle course » or « Modifier la
 * course »: the address the action redirects to (the list of the trip's date,
 * the trip ids, what changed, whether it left its route, the routes
 * recomputed), and what the page reads back. Ids and codes only in the URL,
 * never a name or an address. Pure.
 */
import { decodeRefresh, REFRESH_PARAM, withRefreshNotice, type RefreshOutcome } from "@/lib/planning/refresh-routes";
import { describeEditChanges, EDIT_CHANGE_LABELS, type EditChange } from "./trip-edit";

type Params = Record<string, string | string[] | undefined>;

const EDIT_CHANGES = Object.keys(EDIT_CHANGE_LABELS) as EditChange[];

function first(params: Params, key: string): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

/** « /courses?date=…&notice=created&course=<aller>&retour=<retour> »: one trip, or both legs of « Aller et retour ». */
export function createdTripsHref(date: string, tripIds: readonly string[]): string {
  const params = new URLSearchParams({ date, notice: "created" });
  const [outbound, back] = tripIds;
  if (outbound) params.set("course", outbound);
  if (back) params.set("retour", back);
  return `/courses?${params.toString()}`;
}

/**
 * « /courses?date=…&notice=updated&course=…&modif=date,home[&retiree=1][&tournees=…] » after « Modifier la course ».
 */
export function updatedTripHref(
  date: string,
  tripId: string,
  outcome: { changes: readonly EditChange[]; detached: boolean; refresh: RefreshOutcome },
): string {
  const params = new URLSearchParams({ date, notice: "updated", course: tripId });
  if (outcome.changes.length > 0) params.set("modif", outcome.changes.join(","));
  if (outcome.detached) params.set("retiree", "1");
  return withRefreshNotice(`/courses?${params.toString()}`, outcome.refresh);
}

export type TripNotice =
  | { kind: "created"; tripIds: string[] }
  | { kind: "updated"; tripId: string; changes: EditChange[]; detached: boolean; refresh: RefreshOutcome | null };

/** What the page says, read back from its address; null without a notice (or a malformed one). */
export function readTripNotice(params: Params): TripNotice | null {
  const notice = first(params, "notice");
  const course = first(params, "course");
  if (notice === "created") {
    const ids = [course, first(params, "retour")].filter((id): id is string => Boolean(id));
    return { kind: "created", tripIds: ids };
  }
  if (notice === "updated" && course) {
    const changes = (first(params, "modif") ?? "")
      .split(",")
      .filter((code): code is EditChange => (EDIT_CHANGES as string[]).includes(code));
    return {
      kind: "updated",
      tripId: course,
      changes,
      detached: first(params, "retiree") === "1",
      refresh: decodeRefresh(first(params, REFRESH_PARAM)),
    };
  }
  return null;
}

/** « Course modifiée (date et adresse du patient). » */
export function updatedSentence(changes: readonly EditChange[]): string {
  return changes.length > 0 ? `Course modifiée (${describeEditChanges(changes)}).` : "Course modifiée.";
}
