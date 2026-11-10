import { describe, expect, it } from "vitest";
import { compareLabels, comparePeople, compareVehicles, compareVehiclesByDepot } from "./order";

describe("vehicle and people order", () => {
  it("sorts labels in numeric order, case and accents aside", () => {
    expect(["Taxi 10", "taxi 2", "Taxi 1", "VSL 3"].sort(compareLabels)).toEqual(["Taxi 1", "taxi 2", "Taxi 10", "VSL 3"]);
    expect(compareLabels("Été", "ete")).toBe(0);
  });

  it("puts taxis, then VSL, then ambulances, each in numeric order", () => {
    const vehicles = [
      { type: "AMBULANCE" as const, label: "Ambulance 1" },
      { type: "TAXI" as const, label: "Taxi 10" },
      { type: "VSL" as const, label: "VSL 2" },
      { type: "TAXI" as const, label: "Taxi 2" },
    ];
    expect([...vehicles].sort(compareVehicles).map((v) => v.label)).toEqual(["Taxi 2", "Taxi 10", "VSL 2", "Ambulance 1"]);
  });

  it("groups by depot name first", () => {
    const vehicles = [
      { depotName: "Gap", type: "TAXI" as const, label: "Taxi 1" },
      { depotName: "Aix-en-Provence", type: "AMBULANCE" as const, label: "Ambulance 3" },
      { depotName: "Aix-en-Provence", type: "TAXI" as const, label: "Taxi 22" },
    ];
    expect([...vehicles].sort(compareVehiclesByDepot).map((v) => v.label)).toEqual(["Taxi 22", "Ambulance 3", "Taxi 1"]);
  });

  it("sorts people by last name, then first name", () => {
    const people = [
      { lastName: "Martin", firstName: "Zoé" },
      { lastName: "Éric", firstName: "Anne" },
      { lastName: "Martin", firstName: "Anaïs" },
    ];
    expect([...people].sort(comparePeople).map((p) => `${p.lastName} ${p.firstName}`)).toEqual([
      "Éric Anne",
      "Martin Anaïs",
      "Martin Zoé",
    ]);
  });
});
