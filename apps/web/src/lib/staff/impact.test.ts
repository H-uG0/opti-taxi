import { describe, expect, it } from "vitest";
import { dayStateOf, staffImpactNotice } from "./impact";

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
      " Tournées déjà calculées avec cette personne les 10/11/2026, 12/11/2026 : relancez l'optimisation de ces jours depuis le planning." +
        " Planning déjà validé le 11/11/2026 : changez l'équipage de la tournée (planning, panneau du véhicule, « Changer l'équipage ») ou rouvrez le planning puis relancez l'optimisation." +
        " Journée commencée le 09/11/2026 : changez l'équipage de la tournée (planning, panneau du véhicule, « Changer l'équipage »).",
    );
  });

  it("lists the fixed crews touched: a replacement for a person, a check for a pair", () => {
    const fixed = [
      { date: "2026-11-10", vehicleLabel: "VSL 2" },
      { date: "2026-11-12", vehicleLabel: "Ambulance 1" },
    ];
    expect(staffImpactNotice({ days: [], fixed }, "person")).toBe(
      " Équipages fixés avec cette personne : VSL 2 le 10/11/2026, Ambulance 1 le 12/11/2026 ; un remplaçant y est proposé, à vérifier sur la page Équipages.",
    );
    expect(staffImpactNotice({ days: [{ date: "2026-11-12", state: "proposed" }], fixed: fixed.slice(1) }, "pair")).toBe(
      " Tournées déjà calculées avec ces deux personnes ensemble le 12/11/2026 : relancez l'optimisation de ce jour depuis le planning." +
        " Équipage fixé à revoir sur la page Équipages, ces deux personnes y sont ensemble : Ambulance 1 le 12/11/2026.",
    );
  });

  it("cuts long lists", () => {
    const days = Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-1${i}`, state: "proposed" as const }));
    expect(staffImpactNotice({ days, fixed: [] }, "person")).toMatch(/14\/11\/2026… : relancez/);
  });
});

describe("dayStateOf", () => {
  it("puts a started day before a validated one", () => {
    expect(dayStateOf(true, true)).toBe("started");
    expect(dayStateOf(true, false)).toBe("validated");
    expect(dayStateOf(false, false)).toBe("proposed");
  });
});
