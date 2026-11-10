import { describe, expect, it } from "vitest";
import type { CrewPersonOption } from "./person-options";
import { PARK_VALUE } from "./schema";
import { depotSummaries, needsAttention, parseCrewFilter, type SummaryRow } from "./summary";

function row(vehicleId: string, depotId: string, overrides: Partial<SummaryRow> = {}): SummaryRow {
  return {
    vehicleId,
    depotId,
    depotName: depotId === "gap" ? "Gap" : "Aix-en-Provence",
    type: "TAXI",
    unavailable: false,
    issues: [],
    proposedSeats: [],
    ...overrides,
  };
}

function person(id: string, depotId: string, overrides: Partial<CrewPersonOption> = {}): CrewPersonOption {
  return {
    id,
    name: id,
    active: true,
    depotId,
    absence: null,
    worksThatDay: true,
    canDrive: { TAXI: true, VSL: true, AMBULANCE: false },
    canCrew: false,
    qualifications: "Carte taxi",
    ...overrides,
  };
}

describe("parseCrewFilter", () => {
  const depots = new Set(["gap", "aix"]);
  it("reads the depot (the first of a planning link) and « à traiter »", () => {
    expect(parseCrewFilter(new URLSearchParams("depot=gap&etat=a-traiter"), depots)).toEqual({ depot: "gap", toHandle: true });
    expect(parseCrewFilter({ depot: "aix,gap", etat: "libre,a-traiter" }, depots)).toEqual({ depot: "aix", toHandle: true });
    expect(parseCrewFilter({ depot: "old" }, depots)).toEqual({ depot: null, toHandle: false });
  });
});

describe("needsAttention", () => {
  it("keeps a blocking problem, a proposed replacement, a flagged vehicle or an unsaved change", () => {
    const none = new Set<string>();
    expect(needsAttention(row("t1", "gap"), none, none)).toBe(false);
    expect(needsAttention(row("t1", "gap", { issues: [{ level: "error", seat: "driver", message: "x" }] }), none, none)).toBe(true);
    expect(needsAttention(row("t1", "gap", { issues: [{ level: "info", seat: "driver", message: "x" }] }), none, none)).toBe(false);
    expect(needsAttention(row("t1", "gap", { proposedSeats: ["driver"] }), none, none)).toBe(true);
    expect(needsAttention(row("t1", "gap"), new Set(["t1"]), none)).toBe(true);
    expect(needsAttention(row("t1", "gap"), none, new Set(["t1"]))).toBe(true);
    // Out of service: nothing to do on this page.
    const off = row("t1", "gap", { unavailable: true, issues: [{ level: "error", seat: null, message: "Véhicule indisponible" }] });
    expect(needsAttention(off, new Set(["t1"]), none)).toBe(false);
  });
});

describe("depotSummaries", () => {
  it("counts the seats, filled and missing per depot, and the free people, from the form as it stands", () => {
    const rows = [
      row("t1", "gap"),
      row("a1", "gap", { type: "AMBULANCE" }),
      row("t2", "gap", { unavailable: true }),
      row("t3", "gap"),
      row("t4", "aix"),
    ];
    const values = new Map([
      ["t1", { driver: "ana", mate: "" }],
      ["a1", { driver: "bob", mate: "" }],
      ["t3", { driver: PARK_VALUE, mate: "" }],
      ["t4", { driver: "", mate: "" }],
    ]);
    const people = [
      person("ana", "gap"),
      person("bob", "gap"),
      person("cyd", "gap"),
      person("off", "gap", { worksThatDay: false }),
      person("abs", "gap", { absence: "absence le 11/11/2026" }),
      person("dan", "aix"),
    ];
    const assignments = new Map([
      ["ana", { vehicleId: "t1", label: "Taxi 1" }],
      ["bob", { vehicleId: "a1", label: "Ambulance 1" }],
    ]);
    const [aix, gap] = depotSummaries(rows, values, people, assignments);
    expect(aix).toMatchObject({ depotName: "Aix-en-Provence", vehicles: 1, seats: 1, filled: 0, missing: 1 });
    expect(aix?.free.map((p) => p.id)).toEqual(["dan"]);
    expect(gap).toMatchObject({ vehicles: 4, unavailable: 1, parked: 1, seats: 3, filled: 2, missing: 1 });
    expect(gap?.free.map((p) => p.id)).toEqual(["cyd"]);
  });
});
