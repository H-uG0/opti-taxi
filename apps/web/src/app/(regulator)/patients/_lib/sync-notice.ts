/**
 * Text of the notice shown after a referential save that changed trips: what
 * happened to the trips to come (?courses=…, trip-sync.ts) and to the routes
 * they left (?tournees=…, lib/planning/refresh-routes.ts). Shared by the
 * patient and facility pages.
 *
 * Pure module: unit-tested.
 */
import {
  decodeRefresh,
  REFRESH_PARAM,
  refreshAdvice,
  refreshCallsForReoptimization,
  refreshNotice,
} from "@/lib/planning/refresh-routes";
import { decodeSync, describeSync, SYNC_PARAM } from "./trip-sync";

export type SaveNotice = {
  text: string;
  /** Something is left to the regulator (re-optimize, adjust a trip of today, tell a driver): amber, not blue. */
  needsAction: boolean;
};

type QueryValue = string | string[] | undefined;

function first(value: QueryValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The notice for the page's query parameters, or null when the save changed no trip. */
export function saveNotice(query: Record<string, QueryValue>): SaveNotice | null {
  const summary = decodeSync(first(query[SYNC_PARAM]));
  const outcome = decodeRefresh(first(query[REFRESH_PARAM]));
  // describeSync already asks to re-optimize when trips left their route: the
  // same advice from the recomputation is not repeated (on a day under way it
  // differs: tell the driver).
  const advice =
    outcome && !(summary && summary.detached > 0 && !outcome.dayStarted) ? refreshAdvice(outcome) : "";
  const text = [summary ? describeSync(summary) : null, outcome ? refreshNotice(outcome) : null, advice]
    .filter(Boolean)
    .join(" ");
  if (!text) return null;
  const needsAction =
    (summary !== null && (summary.detached > 0 || summary.deferred > 0)) ||
    (outcome !== null && (refreshCallsForReoptimization(outcome) || outcome.violations > 0 || outcome.kept > 0));
  return { text, needsAction };
}
