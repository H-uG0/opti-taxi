/**
 * GET /tableau-de-bord/export: the dashboard of the same address as a CSV
 * file for a French Excel (KPI-08, lib/kpis-csv.ts): one line per day (or
 * week, or month, ?pas=), or with ?lignes=depot / ?lignes=vehicule one line
 * per step and per depot or vehicle; the depot and type filters apply.
 * Aggregates only (counts, km, rates, euros), never a patient's data: no
 * audit event, like the page's figures.
 */
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { resolveLateTolerance } from "@/lib/kpis";
import { breakdownCsvRows, breakdownCsv, trendCsv } from "@/lib/kpis-csv";
import { trendPoints } from "@/lib/kpis-trend";
import { VEHICLE_TYPE_SHORT } from "@/lib/labels";
import { dashboardLines, loadDashboard } from "../dashboard-data";
import { parseDashboardQuery } from "../query";

export async function GET(request: NextRequest) {
  await requireUser("REGULATOR");
  const search = request.nextUrl.searchParams;
  const params = Object.fromEntries([...search.keys()].map((key) => [key, search.get(key) ?? undefined]));
  const query = parseDashboardQuery(params, resolveLateTolerance(search.get("retard")));
  const dashboard = await loadDashboard(query);
  const { range, options, refs } = dashboard;
  const lines = search.get("lignes");
  let csv: string;
  let suffix = "";
  if (lines === "depot" || lines === "vehicule") {
    const depotName = new Map(refs.depots.map((d) => [d.id, d.name]));
    const vehicle = new Map(refs.vehicles.map((v) => [v.id, v]));
    const by = lines === "depot" ? "depot" : "vehicle";
    const rows = breakdownCsvRows(dashboardLines(dashboard), range, range.granularity, by, {
      depot: (id) => (id ? (depotName.get(id) ?? "") : ""),
      vehicle: (id) => {
        const v = vehicle.get(id);
        return { label: v?.label ?? "", type: v ? VEHICLE_TYPE_SHORT[v.type] : "" };
      },
    });
    csv = breakdownCsv(rows, range.granularity, by, options.lateToleranceMin);
    suffix = lines === "depot" ? "_par-depot" : "_par-vehicule";
  } else {
    csv = trendCsv(trendPoints(dashboard.days, range.granularity), range.granularity, options.lateToleranceMin);
  }
  const filename = `tableau-de-bord_${range.from}_${range.to}${suffix}.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
