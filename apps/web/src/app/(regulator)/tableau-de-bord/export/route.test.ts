import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { computeKpisByDay, DEFAULT_KPI_OPTIONS, summarizePeriod, type KpiData } from "@/lib/kpis";
import { effectiveTargets } from "@/lib/kpis-targets";
import { GET } from "./route";

// The CSV export: a regulator's file, never cached, with a BOM for a French
// Excel, named after its period and its filter. The dashboard is mocked: its
// figures are tested in lib/kpis-csv.test.ts.
const fake = vi.hoisted(() => ({ requireUser: vi.fn(), loadDashboard: vi.fn(), parsedQueries: [] as unknown[] }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ requireUser: fake.requireUser }));
vi.mock("../dashboard-data", () => ({
  loadDashboard: async (query: unknown) => {
    fake.parsedQueries.push(query);
    return fake.loadDashboard(query);
  },
  dashboardLines: () => [],
}));

const data: KpiData = {
  routes: [
    { id: "r1", serviceDate: "2026-11-03", vehicleId: "v1", vehicleType: "TAXI", depotId: "gap", distanceKm: 100, emptyKm: 40, revenue: 0, cost: 150, margin: 0, validatedAt: null, stopCount: 2, hasRecordedStatus: false },
  ],
  trips: [
    { serviceDate: "2026-11-03", status: "ASSIGNED", routeId: "r1", direction: "OUTBOUND", shared: false, appointmentMinute: null, plannedDropoffMinute: null, dropoffCompletedAt: null, estimatedRevenue: 120 },
  ],
  runs: [],
};

function dashboard(scope: { depotId: string | null; vehicleType: "TAXI" | null }) {
  const days = computeKpisByDay("2026-11-03", "2026-11-04", data, "2026-11-10");
  return {
    today: "2026-11-10",
    tomorrow: "2026-11-11",
    range: { from: "2026-11-03", to: "2026-11-04", granularity: "day", explicitGranularity: false, error: null },
    options: DEFAULT_KPI_OPTIONS,
    refs: { vehicles: [], depots: [{ id: "gap", name: "Gap", active: true }], vehicleMeta: new Map(), targets: [] },
    scope,
    scoped: scope.depotId !== null || scope.vehicleType !== null,
    data,
    days,
    period: summarizePeriod(days),
    targets: effectiveTargets([], scope.depotId),
  };
}

function get(query: string) {
  return GET(new NextRequest(`http://localhost:3100/tableau-de-bord/export?${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.parsedQueries.length = 0;
  fake.requireUser.mockResolvedValue({ id: "u1", name: "Régulation", role: "REGULATOR", driverId: null });
});

describe("GET /tableau-de-bord/export", () => {
  it("is a regulator's file, sent as an attachment, never cached, with a BOM", async () => {
    fake.loadDashboard.mockResolvedValue(dashboard({ depotId: null, vehicleType: null }));
    const response = await get("from=2026-11-03&to=2026-11-04");
    expect(fake.requireUser).toHaveBeenCalledWith("REGULATOR");
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="tableau-de-bord_2026-11-03_2026-11-04.csv"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("names a filtered file after its depot and type, and says it on every line", async () => {
    fake.loadDashboard.mockResolvedValue(dashboard({ depotId: "gap", vehicleType: "TAXI" }));
    const response = await get("from=2026-11-03&to=2026-11-04&depot=gap&type=TAXI&lignes=vehicule");
    expect(fake.parsedQueries[0]).toMatchObject({ depotId: "gap", vehicleType: "TAXI" });
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="tableau-de-bord_2026-11-03_2026-11-04_depot-gap_taxis_par-vehicule.csv"',
    );
    const csv = await response.text();
    expect(csv.split("\r\n")[0]).toContain("Périmètre");
  });

  it("refuses a visitor who is not a regulator before reading anything", async () => {
    fake.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(get("from=2026-11-03&to=2026-11-04")).rejects.toThrow("NEXT_REDIRECT");
    expect(fake.loadDashboard).not.toHaveBeenCalled();
  });
});
