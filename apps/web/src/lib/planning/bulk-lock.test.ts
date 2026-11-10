import { describe, expect, it } from "vitest";
import { tripView } from "@/test/planning-fixtures";
import {
  lockMessage,
  scopeLockCounts,
  scopeText,
  scopeTripOf,
  tripsToLock,
  tripsToUnlock,
  unlockMessage,
  type ScopeTrip,
} from "./bulk-lock";

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

describe("scopeLockCounts (the planning's buttons)", () => {
  it("counts from the page's trips exactly what the server would lock and unlock", () => {
    // Depot Gap = t1 and t2. As the page shows them: a trip of a Gap route locked on a Marseille vehicle,
    // a trip without a vehicle locked on t1, a trip planned on Marseille but locked on t2, a cancelled trip
    // still on a route, an exceptional ambulance of Gap.
    const views = [
      tripView({ id: "a", vehicleId: "t1", lockedVehicleId: null }),
      tripView({ id: "b", vehicleId: "t1", lockedVehicleId: "m1" }),
      tripView({ id: "c", vehicleId: null, lockedVehicleId: "t1" }),
      tripView({ id: "d", vehicleId: "m1", lockedVehicleId: "t2" }),
      tripView({ id: "e", vehicleId: "t2", lockedVehicleId: null, status: "CANCELLED" }),
      tripView({ id: "f", vehicleId: "t2", lockedVehicleId: "t2", exceptionalAmbulance: true }),
      tripView({ id: "g", vehicleId: "m1", lockedVehicleId: "m1" }),
    ];
    const gap = only("t1", "t2");
    // The server's rules on the same rows (as loadLockScope reads them from the database).
    const rows = views.map((v) => trip(v.id, v.vehicleId, v.lockedVehicleId, { status: v.status, exceptionalAmbulance: v.exceptionalAmbulance === true }));
    const counts = scopeLockCounts(views.map(scopeTripOf), gap);
    expect(counts).toEqual({ lockable: tripsToLock(rows, gap).count, unlockable: tripsToUnlock(rows, gap).ids.length });
    // « Défiger le dépôt » removes b (its route), c and d (locked on a Gap vehicle), never the ambulance.
    expect(counts).toEqual({ lockable: 1, unlockable: 3 });
    expect(scopeLockCounts(views.map(scopeTripOf), () => true)).toEqual({ lockable: 1, unlockable: 4 });
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
      "Toutes les courses du jour sont déjà figées. 2 courses figées sur un autre véhicule gardent ce verrou.",
    );
    expect(lockMessage({ kind: "depot", depotId: "d" }, "Gap", 0, { lockedElsewhere: 0 })).toBe(
      "Rien à figer dans les tournées du dépôt Gap : leurs courses sont déjà figées.",
    );
    expect(lockMessage({ kind: "route", vehicleId: "t1" }, "Taxi 1", 0, { lockedElsewhere: 0 })).toBe(
      "Rien à figer dans la tournée de Taxi 1 : ses courses sont déjà figées.",
    );
    expect(unlockMessage({ kind: "depot", depotId: "d" }, "Gap", 1, { keptExceptional: 2 })).toBe(
      "Les tournées du dépôt Gap : 1 course défigée, la prochaine optimisation pourra la changer de véhicule. 2 recours exceptionnels à une ambulance restent figés : défigez-les depuis la course.",
    );
    expect(unlockMessage({ kind: "route", vehicleId: "t1" }, "Taxi 1", 0, { keptExceptional: 0 })).toBe("Rien à défiger dans la tournée de Taxi 1.");
    expect(unlockMessage({ kind: "day" }, null, 0, { keptExceptional: 0 })).toBe("Aucune course du jour n'est figée.");
  });
});
