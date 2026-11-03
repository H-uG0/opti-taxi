/**
 * Loads the rows the dashboard indicators are computed from, for a whole
 * date range: the four queries and their mapping are in @/lib/kpis-load
 * (shared with the history script), run here with the app's client. The
 * computation itself is in @/lib/kpis.
 */
import "server-only";
import { db } from "@/lib/db";
import type { KpiData } from "@/lib/kpis";
import { loadKpiRows } from "@/lib/kpis-load";

export function loadKpiData(from: string, to: string): Promise<KpiData> {
  return loadKpiRows(db, from, to);
}
