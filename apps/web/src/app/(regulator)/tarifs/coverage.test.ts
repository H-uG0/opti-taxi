import { describe, expect, it } from "vitest";
import type { TariffCoverageAlert } from "@/lib/domain/tariffs";
import { coverageAlertText } from "./coverage";

const base: TariffCoverageAlert = {
  vehicleType: "VSL",
  department: "04",
  vehicles: ["VSL 2"],
  kind: "missing",
  uncoveredFrom: "2026-11-10",
  expiring: null,
  resumesOn: null,
};

describe("coverageAlertText", () => {
  it("names the grid that expires with nothing after it", () => {
    const alert: TariffCoverageAlert = {
      ...base,
      kind: "expires",
      uncoveredFrom: "2026-12-01",
      expiring: { id: "g1", department: "04", label: null, validTo: "2026-11-30" },
    };
    expect(coverageAlertText(alert)).toBe("La grille VSL 04 expire le 30/11/2026\u00a0: aucune ne prend le relais.");
    expect(coverageAlertText({ ...alert, expiring: { id: "g1", department: "*", label: "Avenant 2025", validTo: "2026-11-30" } })).toBe(
      "La grille VSL toutes zones «\u202fAvenant 2025\u202f» expire le 30/11/2026\u00a0: aucune ne prend le relais.",
    );
    expect(coverageAlertText({ ...alert, resumesOn: "2026-12-03" })).toBe(
      "La grille VSL 04 expire le 30/11/2026 et la prochaine ne commence que le 03/12/2026.",
    );
  });

  it("says when no grid is in force on the first day", () => {
    expect(coverageAlertText(base)).toBe("Aucune grille en vigueur le 10/11/2026.");
    expect(coverageAlertText({ ...base, resumesOn: "2026-11-13" })).toBe(
      "Aucune grille en vigueur le 10/11/2026\u202f; la prochaine ne commence que le 13/11/2026.",
    );
  });
});
