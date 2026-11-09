import { describe, expect, it } from "vitest";
import { Rng } from "../seed/random";
import { dailyKm, fuelDecision, nominalKm, rebuildFuelLog, refillRange } from "./fuel";

const diesel = { per100Km: 7, price: 1.7 };

describe("km of each day", () => {
  it("take the route's km on a day with stored routes (0 without a route), the average elsewhere, nothing on Sundays", () => {
    const routeKm = new Map([
      ["2026-10-12", 120],
      ["2026-10-14", 80],
    ]);
    expect(nominalKm(routeKm, 90)).toBe(100);
    expect(nominalKm(new Map(), 90)).toBe(90);
    const days = dailyKm(["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"], {
      plannedDays: new Set(["2026-10-12", "2026-10-13", "2026-10-14"]),
      routeKm,
      nominalKm: 100,
      isSunday: (date) => date === "2026-10-11",
    });
    expect(days.map((d) => d.km)).toEqual([0, 120, 0, 80, 100]);
  });
});

describe("which fill-ups are rebuilt", () => {
  const owned = (id: string) => id.startsWith("seed-fuel-") || id.startsWith("hist-");
  const fill = (id: string, date: string, odometerKm: number) => ({ id, date, odometerKm });

  it("rebuilds the seed's and the simulation's from the oldest of them, keeping the last reading", () => {
    const fills = [
      fill("seed-fuel-v1-1", "2026-09-20", 140_000),
      fill("hist-fuel-v1-2", "2026-10-05", 141_200),
      fill("seed-fuel-v1-3", "2026-10-20", 142_100),
    ];
    expect(fuelDecision(fills, owned, "2026-10-01")).toEqual({
      kind: "rebuild",
      from: "2026-09-20",
      ownedIds: ["seed-fuel-v1-1", "hist-fuel-v1-2", "seed-fuel-v1-3"],
      finalOdometerKm: 142_100,
    });
    // Recent fill-ups only: the window still starts at `defaultFrom` (the simulated days a week before).
    expect(fuelDecision([fill("hist-fuel-v1-1", "2026-10-20", 1000)], owned, "2026-10-01")).toMatchObject({ from: "2026-10-01" });
  });

  it("never replaces a fill-up recorded in the app: inside the window the vehicle is left as it is", () => {
    const fills = [
      fill("seed-fuel-v1-1", "2026-09-20", 140_000),
      fill("cmvzfuel", "2026-10-10", 141_000),
      fill("seed-fuel-v1-2", "2026-10-20", 142_100),
    ];
    expect(fuelDecision(fills, owned, "2026-10-01")).toEqual({ kind: "app-fill-up" });
    // On the first day of the window too.
    expect(fuelDecision([fill("seed-fuel-v1-1", "2026-09-20", 1), fill("cmvzfuel", "2026-09-20", 2)], owned, "2026-10-01")).toEqual({
      kind: "app-fill-up",
    });
  });

  it("rebuilds when the app's fill-up is before the window, without deleting it", () => {
    const fills = [
      fill("cmvzfuel", "2026-09-01", 139_000),
      fill("seed-fuel-v1-1", "2026-09-20", 140_000),
      fill("seed-fuel-v1-2", "2026-10-20", 142_100),
    ];
    const decision = fuelDecision(fills, owned, "2026-10-01");
    expect(decision).toMatchObject({ kind: "rebuild", from: "2026-09-20", finalOdometerKm: 142_100 });
    expect(decision.kind === "rebuild" && decision.ownedIds).toEqual(["seed-fuel-v1-1", "seed-fuel-v1-2"]);
  });

  it("leaves alone, and says so, a vehicle with no fill-up of the seed nor of a simulation (an older seed's)", () => {
    expect(fuelDecision([fill("cmvzold1", "2026-09-20", 140_000), fill("cmvzold2", "2026-10-20", 142_000)], owned, "2026-10-01")).toEqual({
      kind: "not-owned",
    });
    expect(fuelDecision([], owned, "2026-10-01")).toEqual({ kind: "not-owned" });
  });
});

describe("rebuilt fill-ups", () => {
  const days = Array.from({ length: 30 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, km: i % 7 === 6 ? 0 : 110 }));
  const total = days.reduce((sum, d) => sum + d.km, 0);

  it("end on the last day at the same reading, counted back from it, with increasing odometers", () => {
    const fills = rebuildFuelLog(days, 150_000, diesel, false, new Rng(1));
    expect(fills[0]?.date).toBe("2026-10-01");
    expect(fills.at(-1)).toMatchObject({ date: "2026-10-30", odometerKm: 150_000 });
    expect(fills[0]?.odometerKm).toBe(150_000 - total + 110);
    for (let i = 1; i < fills.length; i++) expect(fills[i]!.odometerKm).toBeGreaterThan(fills[i - 1]!.odometerKm);
  });

  it("fill up when the range is used, with the fuel of the consumption ± 5 %", () => {
    const fills = rebuildFuelLog(days, 150_000, diesel, false, new Rng(2));
    const [min, max] = refillRange(false);
    for (let i = 1; i < fills.length - 1; i++) {
      const km = fills[i]!.odometerKm - fills[i - 1]!.odometerKm;
      expect(km).toBeGreaterThanOrEqual(min);
      expect(km).toBeLessThan(max + 110);
      expect(fills[i]!.quantity / km * 100).toBeGreaterThan(diesel.per100Km * 0.94);
      expect(fills[i]!.quantity / km * 100).toBeLessThan(diesel.per100Km * 1.06);
      expect(fills[i]!.cost).toBeCloseTo(fills[i]!.quantity * diesel.price, 2);
    }
  });

  it("take the last reading on the last day the vehicle drove, not on the Sunday after", () => {
    const withSunday = [...days.slice(0, 27), { date: "2026-10-28", km: 0 }];
    const fills = rebuildFuelLog(withSunday, 150_000, diesel, false, new Rng(4));
    expect(fills.at(-1)).toMatchObject({ date: "2026-10-27", odometerKm: 150_000 });
  });

  it("charge an electric car more often, and give nothing for an empty window", () => {
    const electric = rebuildFuelLog(days, 50_000, { per100Km: 17.5, price: 0.26 }, true, new Rng(3));
    expect(electric.length).toBeGreaterThan(rebuildFuelLog(days, 50_000, diesel, false, new Rng(3)).length);
    expect(rebuildFuelLog([], 1000, diesel, false, new Rng(1))).toEqual([]);
  });
});
