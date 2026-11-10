import { describe, expect, it } from "vitest";
import { lockMessage, scopeText, tripsToLock, tripsToUnlock, unlockMessage, type ScopeTrip } from "./bulk-lock";

const trip = (id: string, routeVehicleId: string | null, lockedVehicleId: string | null = null, extra: Partial<ScopeTrip> = {}): ScopeTrip => ({
  id,
  status: "ASSIGNED",
  lockedVehicleId,
  routeVehicleId,
  exceptionalAmbulance: false,
  ...extra,
});

const only = (...ids: string[]) => (vehicleId: string) => ids.includes(vehicleId);

describe("tripsToLock", () => {
  it("locks the active unlocked trips of the scope's routes, by vehicle, and counts those locked elsewhere", () => {
    const plan = tripsToLock(
      [
        trip("a", "t1"),
        trip("b", "t2"),
        trip("c", "t1", "t1"),
        trip("d", "t1", "v9"),
        trip("e", "t1", null, { status: "CANCELLED" }),
        trip("f", "t1", null, { status: "NO_SHOW" }),
        trip("g", null),
        trip("h", "x9"),
      ],
      only("t1", "t2"),
    );
    expect([...plan.byVehicle]).toEqual([
      ["t1", ["a"]],
      ["t2", ["b"]],
    ]);
    expect(plan.count).toBe(2);
    expect(plan.lockedElsewhere).toBe(1);
  });
});

describe("tripsToUnlock", () => {
  it("unlocks the locks on the scope's vehicles or routes, never an exceptional ambulance", () => {
    const plan = tripsToUnlock(
      [
        trip("a", "t1", "t1"),
        trip("b", null, "t1"),
        trip("c", "t1", "v9"),
        trip("d", "v9", "v9"),
        trip("e", "t1"),
        trip("amb", "a1", "t1", { exceptionalAmbulance: true }),
      ],
      only("t1"),
    );
    expect(plan).toEqual({ ids: ["a", "b", "c"], keptExceptional: 1 });
  });
});

describe("messages", () => {
  it("names the scope", () => {
    expect(scopeText({ kind: "route", vehicleId: "t1" }, "Taxi 1")).toBe("la tournée de Taxi 1");
    expect(scopeText({ kind: "depot", depotId: "d" }, "Gap")).toBe("les tournées du dépôt Gap");
    expect(scopeText({ kind: "day" }, null)).toBe("toutes les tournées du jour");
  });

  it("agrees with the number of trips", () => {
    expect(lockMessage({ kind: "route", vehicleId: "t1" }, "Taxi 1", 1, { lockedElsewhere: 0 })).toBe(
      "La tournée de Taxi 1 : 1 course figée, elle restera sur son véhicule à la prochaine optimisation.",
    );
    expect(lockMessage({ kind: "day" }, null, 0, { lockedElsewhere: 2 })).toBe(
      "Rien à figer dans toutes les tournées du jour : ses courses sont déjà figées. 2 courses figées sur un autre véhicule gardent ce verrou.",
    );
    expect(unlockMessage({ kind: "depot", depotId: "d" }, "Gap", 1, { keptExceptional: 2 })).toBe(
      "Les tournées du dépôt Gap : 1 course défigée, la prochaine optimisation pourra la changer de véhicule. 2 recours exceptionnels à une ambulance restent figés : défigez-les depuis la course.",
    );
    expect(unlockMessage({ kind: "route", vehicleId: "t1" }, "Taxi 1", 0, { keptExceptional: 0 })).toBe("Rien à défiger dans la tournée de Taxi 1.");
  });
});
