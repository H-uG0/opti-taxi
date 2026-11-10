import { describe, expect, it } from "vitest";
import type { ViolationView } from "./types";
import { indexViolations, violationLabels } from "./violation-index";

const violation = (overrides: Partial<ViolationView>): ViolationView => ({
  code: "TIME_WINDOW",
  label: "Hors fenêtre horaire",
  message: "Arrivée après le RDV",
  tripId: null,
  vehicleId: null,
  ...overrides,
});

describe("violations by trip and by vehicle", () => {
  it("counts a trip's violation for the vehicle that carries it, and a vehicle's own violation", () => {
    const trips = { a: { vehicleId: "v1" }, b: { vehicleId: null } };
    const onTrip = violation({ tripId: "a" });
    const onVehicle = violation({ code: "BREAK", label: "Pause manquante", vehicleId: "v1" });
    const unassigned = violation({ tripId: "b" });
    const index = indexViolations([onTrip, onVehicle, unassigned], trips);
    expect(index.byTrip.get("a")).toEqual([onTrip]);
    expect(index.byTrip.get("b")).toEqual([unassigned]);
    expect(index.byVehicle.get("v1")).toEqual([onTrip, onVehicle]);
    expect(index.byVehicle.size).toBe(1);
    expect(violationLabels([onTrip, onTrip, onVehicle])).toBe("Hors fenêtre horaire, Pause manquante");
  });
});
