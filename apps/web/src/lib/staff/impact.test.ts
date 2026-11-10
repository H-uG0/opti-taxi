import { describe, expect, it, vi } from "vitest";
import { dayStateOf, loadStaffImpact, staffImpactNotice } from "./impact";

describe("staffImpactNotice", () => {
  it("says nothing when no planned day nor fixed crew is touched", () => {
    expect(staffImpactNotice({ days: [], fixed: [] }, "person")).toBe("");
  });

  it("tells proposed, validated and started days apart, with what to do on each", () => {
    const notice = staffImpactNotice(
      {
        days: [
          { date: "2026-11-10", state: "proposed" },
          { date: "2026-11-12", state: "proposed" },
          { date: "2026-11-11", state: "validated" },
          { date: "2026-11-09", state: "started" },
        ],
        fixed: [],
      },
      "person",
    );
    expect(notice).toBe(
      " Tournées déjà calculées avec cette personne les 10/11/2026, 12/11/2026\u00a0: relancez l'optimisation de ces jours depuis le planning." +
        " Planning déjà validé le 11/11/2026\u00a0: changez l'équipage de la tournée (planning, panneau du véhicule, «\u202fChanger l'équipage\u202f») ou rouvrez le planning puis relancez l'optimisation." +
        " Journée commencée le 09/11/2026\u00a0: changez l'équipage de la tournée (planning, panneau du véhicule, «\u202fChanger l'équipage\u202f»).",
    );
  });

  it("lists the fixed crews touched: a seat to replace for a person, a check for a pair", () => {
    const fixed = [
      { date: "2026-11-10", vehicleLabel: "VSL 2" },
      { date: "2026-11-12", vehicleLabel: "Ambulance 1" },
    ];
    expect(staffImpactNotice({ days: [], fixed }, "person")).toBe(
      " Équipages fixés avec cette personne\u00a0: VSL 2 le 10/11/2026, Ambulance 1 le 12/11/2026\u202f; ses postes sont à remplacer, voir la page Équipages.",
    );
    expect(staffImpactNotice({ days: [{ date: "2026-11-12", state: "proposed" }], fixed: fixed.slice(1) }, "pair")).toBe(
      " Tournées déjà calculées avec ces deux personnes ensemble le 12/11/2026\u00a0: relancez l'optimisation de ce jour depuis le planning." +
        " Équipage fixé à revoir sur la page Équipages, ces deux personnes y sont ensemble\u00a0: Ambulance 1 le 12/11/2026.",
    );
  });

  it("cuts long lists", () => {
    const days = Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-1${i}`, state: "proposed" as const }));
    expect(staffImpactNotice({ days, fixed: [] }, "person")).toMatch(/14\/11\/2026…\u00a0: relancez/);
  });
});

describe("dayStateOf", () => {
  it("puts a started day before a validated one", () => {
    expect(dayStateOf(true, true)).toBe("started");
    expect(dayStateOf(true, false)).toBe("validated");
    expect(dayStateOf(false, false)).toBe("proposed");
  });
});

describe("loadStaffImpact", () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

  it("drops the fixed crews of a validated or started day, even without a route of the person", async () => {
    // The person has no route; two fixed crews: a validated day (spare vehicle without trips) and a proposed day.
    const prisma = {
      route: {
        findMany: vi
          .fn()
          // Routes of the person.
          .mockResolvedValueOnce([])
          // Validated days among the days checked.
          .mockResolvedValueOnce([{ serviceDate: day("2099-01-06") }]),
      },
      dayCrew: {
        findMany: vi.fn().mockResolvedValue([
          { serviceDate: day("2099-01-06"), vehicle: { label: "Taxi 3" } },
          { serviceDate: day("2099-01-07"), vehicle: { label: "VSL 2" } },
        ]),
      },
      trip: { findMany: vi.fn().mockResolvedValue([]) },
      routeStop: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const impact = await loadStaffImpact(prisma as never, ["d1"], "2099-01-05", "2099-01-09");
    expect(impact).toEqual({ days: [], fixed: [{ date: "2099-01-07", vehicleLabel: "VSL 2" }] });
    // The day states were read for the dates of the fixed crews.
    expect(prisma.route.findMany.mock.calls[1]![0].where.serviceDate.in).toEqual([day("2099-01-06"), day("2099-01-07")]);
  });
});
