import { describe, expect, it } from "vitest";
import { computeKpisByDay, type KpiData } from "./kpis";
import { routeLines } from "./kpis-breakdown";
import { breakdownCsv, breakdownCsvRows, csvDate, csvField, csvNumber, toCsv, trendCsv } from "./kpis-csv";
import { trendPoints } from "./kpis-trend";

/** The cells of a CSV line (no field of these tests is quoted). */
function cells(line: string | undefined): string[] {
  return (line ?? "").split(";");
}

describe("CSV for a French Excel", () => {
  it("writes a BOM, « ; » between fields, CRLF line ends and a decimal comma", () => {
    const csv = toCsv(["Date", "Km"], [[csvDate("2026-11-03"), csvNumber(1234.56, 1)]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toBe("﻿Date;Km\r\n03/11/2026;1234,6\r\n");
  });

  it("formats numbers without separators, unknown values empty", () => {
    expect(csvNumber(0.5, 2)).toBe("0,50");
    expect(csvNumber(-12.5, 2)).toBe("-12,50");
    expect(csvNumber(-0.001, 1)).toBe("0,0");
    expect(csvNumber(null)).toBe("");
    expect(csvNumber(Number.NaN)).toBe("");
  });

  it("quotes a field holding « ; », a quote or a line break, and makes a formula inert", () => {
    expect(csvField('Taxi "Gap"; 2')).toBe('"Taxi ""Gap""; 2"');
    expect(csvField("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvField("-12,50")).toBe("-12,50");
    expect(csvField(3)).toBe("3");
    expect(csvField(null)).toBe("");
  });
});

const data: KpiData = {
  routes: [
    { id: "r1", serviceDate: "2026-11-03", vehicleId: "v1", vehicleType: "TAXI", depotId: "gap", distanceKm: 100.25, emptyKm: 40, revenue: 0, cost: 150.5, margin: 0, validatedAt: null, stopCount: 2, hasRecordedStatus: false },
    { id: "r2", serviceDate: "2026-11-04", vehicleId: "v2", vehicleType: "VSL", depotId: "sis", distanceKm: 80, emptyKm: 20, revenue: 0, cost: 90, margin: 0, validatedAt: null, stopCount: 2, hasRecordedStatus: false },
  ],
  trips: [
    { serviceDate: "2026-11-03", status: "ASSIGNED", routeId: "r1", direction: "OUTBOUND", shared: false, appointmentMinute: null, plannedDropoffMinute: null, dropoffCompletedAt: null, estimatedRevenue: 120.4 },
    { serviceDate: "2026-11-04", status: "ASSIGNED", routeId: "r2", direction: "OUTBOUND", shared: false, appointmentMinute: null, plannedDropoffMinute: null, dropoffCompletedAt: null, estimatedRevenue: 60 },
  ],
  runs: [],
};

describe("trendCsv", () => {
  it("writes one line per day with the aggregates only", () => {
    const days = computeKpisByDay("2026-11-03", "2026-11-04", data, "2026-11-10");
    const lines = trendCsv(trendPoints(days, "day"), "day", 5).replace("﻿", "").split("\r\n");
    const header = cells(lines[0]);
    expect(header[0]).toBe("Date");
    expect(header).toContain("Taux de service (%)");
    expect(header).toContain("Retards (plus de 5 min après le RDV)");
    const first = Object.fromEntries(header.map((h, i) => [h, cells(lines[1])[i]]));
    expect(first).toMatchObject({ Date: "03/11/2026", Servies: "1", Km: "100,3", "Taux de service (%)": "100,0", "Marge (€)": "-30,10" });
    expect(lines).toHaveLength(4); // header, 2 days, the final CRLF
  });

  it("writes a week with its first and last days", () => {
    const days = computeKpisByDay("2026-11-03", "2026-11-04", data, "2026-11-10");
    const lines = trendCsv(trendPoints(days, "week"), "week", 0).split("\r\n");
    expect(cells(lines[0]).slice(0, 2)).toEqual(["﻿Du", "Au"]);
    expect(cells(lines[1]).slice(0, 2)).toEqual(["03/11/2026", "04/11/2026"]);
  });
});

describe("breakdownCsv", () => {
  it("writes one line per day and per depot, or per vehicle with its type", () => {
    const lines = routeLines(data, "2026-11-10");
    const names = { depot: (id: string | null) => ({ gap: "Gap", sis: "Sisteron" })[id ?? ""] ?? "", vehicle: (id: string) => ({ label: `Taxi ${id}`, type: "Taxi" }) };
    const byDepot = breakdownCsvRows(lines, { from: "2026-11-01", to: "2026-11-30" }, "day", "depot", names);
    expect(byDepot.map((r) => [r.key, r.depot, r.totals.trips])).toEqual([
      ["2026-11-03", "Gap", 1],
      ["2026-11-04", "Sisteron", 1],
    ]);
    const csv = breakdownCsv(byDepot, "day", "depot", 5).split("\r\n");
    expect(cells(csv[0]).slice(0, 3)).toEqual(["﻿Date", "Dépôt", "Véhicules utilisés"]);
    const byMonth = breakdownCsvRows(lines, { from: "2026-11-02", to: "2026-11-20" }, "month", "vehicle", names);
    expect(byMonth[0]).toMatchObject({ key: "2026-11-01", from: "2026-11-02", to: "2026-11-20", vehicle: { label: "Taxi v1" } });
    expect(cells(breakdownCsv(byMonth, "month", "vehicle", 5).split("\r\n")[0]).slice(0, 5)).toEqual(["﻿Du", "Au", "Dépôt", "Véhicule", "Type"]);
  });
});
