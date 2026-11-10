import { describe, expect, it } from "vitest";
import type { SearchSelectGroup, SearchSelectOption } from "@/components/ui/search-select";
import { assignmentsOf, seatOptions, unavailableReason, type CrewPersonOption, type DepotInfo, type SeatContext } from "./person-options";
import { PARK_VALUE } from "./schema";

function person(id: string, overrides: Partial<CrewPersonOption> = {}): CrewPersonOption {
  return {
    id,
    name: id.toUpperCase(),
    active: true,
    depotId: "gap",
    absence: null,
    worksThatDay: true,
    canDrive: { TAXI: true, VSL: true, AMBULANCE: false },
    canCrew: false,
    qualifications: "Carte taxi",
    ...overrides,
  };
}

const PEOPLE = [
  person("zoe"),
  person("anna"),
  person("rest", { worksThatDay: false }),
  person("far", { depotId: "marseille" }),
  person("near", { depotId: "sisteron" }),
  person("busy"),
  person("sick", { absence: "absence du 10/11/2026 au 12/11/2026" }),
  person("gone", { active: false }),
  person("dea", { canDrive: { TAXI: false, VSL: true, AMBULANCE: true }, canCrew: true, qualifications: "DEA" }),
];

const DEPOTS: DepotInfo = {
  names: new Map([
    ["gap", "Gap"],
    ["marseille", "Marseille"],
    ["sisteron", "Sisteron"],
  ]),
  km: new Map([["gap", new Map([["gap", 0], ["marseille", 152.4], ["sisteron", 39.6]])]]),
};

const TAXI_SEAT: SeatContext = { vehicleId: "t1", type: "TAXI", depotId: "gap", seat: "driver", otherSeatValue: "" };
const SPECIAL: SearchSelectOption[] = [{ value: "", label: "— Aucun chauffeur —" }];

const groupsOf = (items: ReturnType<typeof seatOptions>) =>
  items.filter((i): i is SearchSelectGroup => "options" in i).map((g) => [g.label, g.options.map((o) => o.value)]);

describe("seatOptions", () => {
  it("groups the free people of the depot, the other depots by distance, those already on a vehicle, then those who cannot", () => {
    const assignments = new Map([["busy", { vehicleId: "t9", label: "Taxi 9 (Gap)" }]]);
    const items = seatOptions(PEOPLE, TAXI_SEAT, assignments, DEPOTS, SPECIAL);
    expect(items[0]).toEqual(SPECIAL[0]);
    expect(groupsOf(items)).toEqual([
      ["Libres — dépôt Gap", ["anna", "zoe", "rest"]],
      ["Libres — autres dépôts", ["near", "far"]],
      ["Déjà sur un autre véhicule", ["busy"]],
      ["Absents ou désactivés", ["gone", "sick"]],
      ["Non qualifiés pour ce poste", ["dea"]],
    ]);
    // The people not qualified only show once a name is typed (SearchSelect).
    expect(items.find((i) => "options" in i && i.label === "Non qualifiés pour ce poste")).toMatchObject({ searchOnly: true });
  });

  it("says where each person comes from, and why the others cannot take the seat", () => {
    const items = seatOptions(PEOPLE, TAXI_SEAT, new Map([["busy", { vehicleId: "t9", label: "Taxi 9 (Gap)" }]]), DEPOTS, []);
    const all = items.flatMap((i) => ("options" in i ? i.options : [i]));
    const hint = (id: string) => all.find((o) => o.value === id);
    expect(hint("near")?.hint).toBe("Sisteron, 40 km · Carte taxi");
    expect(hint("rest")?.hint).toBe("Carte taxi · hors de ses jours habituels");
    expect(hint("busy")?.hint).toBe("sur Taxi 9 (Gap) · Gap");
    expect(hint("sick")).toMatchObject({ disabled: true, hint: "absence du 10/11/2026 au 12/11/2026" });
    expect(hint("gone")).toMatchObject({ disabled: true, hint: "désactivé" });
    expect(hint("dea")).toMatchObject({ disabled: true, hint: "non qualifié pour ce poste" });
  });

  it("keeps the person of this seat in the free groups, and refuses the one at the other seat", () => {
    const assignments = new Map([
      ["anna", { vehicleId: "t1", label: "Taxi 1" }],
      ["dea", { vehicleId: "t1", label: "Taxi 1" }],
    ]);
    expect(groupsOf(seatOptions(PEOPLE, TAXI_SEAT, assignments, DEPOTS, []))[0]?.[1]).toContain("anna");
    const mateSeat: SeatContext = { vehicleId: "a1", type: "AMBULANCE", depotId: "gap", seat: "crewMate", otherSeatValue: "dea" };
    expect(unavailableReason(PEOPLE.find((p) => p.id === "dea")!, mateSeat)).toBe("déjà à l'autre poste de ce véhicule");
  });
});

describe("assignmentsOf", () => {
  it("follows the form as it stands, ignoring a vehicle out of service and the crew mate of a vehicle left at the depot", () => {
    const rows = [
      { vehicleId: "t1", label: "Taxi 1", unavailable: false },
      { vehicleId: "a1", label: "Ambulance 1", unavailable: false },
      { vehicleId: "a2", label: "Ambulance 2", unavailable: false },
      { vehicleId: "t2", label: "Taxi 2", unavailable: true },
    ];
    const values = new Map([
      ["t1", { driver: "anna", mate: "" }],
      ["a1", { driver: "dea", mate: "zoe" }],
      ["a2", { driver: PARK_VALUE, mate: "far" }],
      ["t2", { driver: "near", mate: "" }],
    ]);
    expect([...assignmentsOf(rows, values).entries()]).toEqual([
      ["anna", { vehicleId: "t1", label: "Taxi 1" }],
      ["dea", { vehicleId: "a1", label: "Ambulance 1" }],
      ["zoe", { vehicleId: "a1", label: "Ambulance 1" }],
    ]);
  });
});
