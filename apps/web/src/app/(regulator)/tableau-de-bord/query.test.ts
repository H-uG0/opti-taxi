import { describe, expect, it } from "vitest";
import { dashboardHref, exportHref, parseDashboardQuery } from "./query";

describe("parseDashboardQuery", () => {
  it("reads the tab, the scope and the breakdown, unknown values back to the defaults", () => {
    expect(
      parseDashboardQuery({ vue: "ventilation", depot: "ck123", type: "VSL", par: "vehicule", tri: "-marge", pas: "mois", from: "2026-01-01" }, 5),
    ).toMatchObject({ tab: "ventilation", depotId: "ck123", vehicleType: "VSL", axis: "vehicule", sort: "-marge", step: "mois", from: "2026-01-01" });
    expect(parseDashboardQuery({ vue: "admin", depot: "x'; drop", type: "BUS", par: "?", tri: "1=1" }, 10)).toMatchObject({
      tab: "synthese",
      depotId: null,
      vehicleType: null,
      axis: "depot",
      sort: null,
      tolerance: 10,
    });
    expect(parseDashboardQuery({ vue: ["flotte", "partage"] }, 5).tab).toBe("flotte");
  });
});

describe("links", () => {
  const base = { from: "2026-11-01", to: "2026-11-14", tolerance: 5, depotId: "gap", vehicleType: "TAXI" as const };

  it("keeps the filters and leaves the defaults out", () => {
    expect(dashboardHref({ ...base, tab: "synthese" })).toBe("/tableau-de-bord?from=2026-11-01&to=2026-11-14&depot=gap&type=TAXI");
    expect(dashboardHref({ ...base, tab: "ventilation", axis: "chauffeur", sort: "-courses", granularity: "week", tolerance: 0 })).toBe(
      "/tableau-de-bord?vue=ventilation&from=2026-11-01&to=2026-11-14&pas=semaine&retard=0&depot=gap&type=TAXI&par=chauffeur&tri=-courses",
    );
  });

  it("exports the same period and scope, without the tab, the day or the order", () => {
    expect(exportHref({ ...base, tab: "ventilation", day: "2026-11-03", sort: "-km", granularity: "month" }, "vehicule")).toBe(
      "/tableau-de-bord/export?from=2026-11-01&to=2026-11-14&pas=mois&depot=gap&type=TAXI&lignes=vehicule",
    );
    expect(exportHref(base, "jour")).toBe("/tableau-de-bord/export?from=2026-11-01&to=2026-11-14&depot=gap&type=TAXI");
  });
});
