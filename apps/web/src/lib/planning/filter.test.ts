import { describe, expect, it } from "vitest";
import { planningFixture, tripView, vehicleRow } from "@/test/planning-fixtures";
import {
  depotChoices,
  depotGroupViews,
  EMPTY_FILTER,
  filterQuery,
  filterRows,
  groupByDepot,
  isFiltering,
  issueVehicleIds,
  lockableTripCount,
  lockedTripCount,
  matchesFilter,
  parseFilter,
  sanitizeFilter,
  subsetKpis,
  vehicleStates,
} from "./filter";
import { computeDayKpis, type KpiRouteSource, type KpiTripSource } from "./view";

const NONE = new Set<string>();

describe("filter in the URL", () => {
  it("reads depots, types, states, « masquer les libres », folded groups and density", () => {
    const filter = parseFilter(
      new URLSearchParams("date=2026-11-10&depot=d1,d2,d1&type=taxi,ambulance,bus&etat=libre,a-traiter&masquer=libres&replie=d2&densite=compacte"),
    );
    expect(filter).toEqual({
      depots: ["d1", "d2"],
      types: ["TAXI", "AMBULANCE"],
      states: ["free", "issue"],
      hideFree: true,
      collapsed: ["d2"],
      compact: true,
    });
    expect(parseFilter({})).toEqual(EMPTY_FILTER);
    // A record of the page's searchParams works too (first value of a repeated key).
    expect(parseFilter({ type: ["vsl", "taxi"], depot: "a b,<x>,ok" }).types).toEqual(["VSL"]);
    expect(parseFilter({ depot: "a b,<x>,ok" }).depots).toEqual(["ok"]);
  });

  it("writes the filter back, keeping the date and the trip, and round-trips", () => {
    const current = new URLSearchParams("date=2026-11-10&trip=t1&depot=old");
    const filter = { ...EMPTY_FILTER, depots: ["d1", "d2"], types: ["VSL" as const], states: ["off" as const], hideFree: true, compact: true };
    const query = filterQuery(current, filter);
    expect(query).toBe("?date=2026-11-10&trip=t1&depot=d1%2Cd2&type=vsl&etat=indisponible&masquer=libres&densite=compacte");
    expect(parseFilter(new URLSearchParams(query))).toEqual(filter);
    expect(filterQuery(new URLSearchParams("depot=d1"), EMPTY_FILTER)).toBe("");
  });

  it("drops depots that no longer exist, and tells a filter from a mere layout choice", () => {
    const filter = { ...EMPTY_FILTER, depots: ["d1", "gone"], collapsed: ["gone"] };
    expect(sanitizeFilter(filter, new Set(["d1"]))).toEqual({ ...EMPTY_FILTER, depots: ["d1"], collapsed: [] });
    const same = { ...EMPTY_FILTER, depots: ["d1"] };
    expect(sanitizeFilter(same, new Set(["d1"]))).toBe(same);
    expect(isFiltering({ ...EMPTY_FILTER, collapsed: ["d1"], compact: true })).toBe(false);
    expect(isFiltering({ ...EMPTY_FILTER, hideFree: true })).toBe(true);
  });
});

describe("which vehicles a filter keeps", () => {
  const { vehicles } = planningFixture();
  const [taxi, freeVsl, ambulance, offVsl] = vehicles as [
    ReturnType<typeof vehicleRow>,
    ReturnType<typeof vehicleRow>,
    ReturnType<typeof vehicleRow>,
    ReturnType<typeof vehicleRow>,
  ];

  it("gives each vehicle its states", () => {
    expect(vehicleStates(taxi, NONE)).toEqual(["route"]);
    expect(vehicleStates(freeVsl, NONE)).toEqual(["free"]);
    expect(vehicleStates(offVsl, new Set(["vsl-2"]))).toEqual(["off", "issue"]);
    // A route left on a vehicle off the road since: both.
    expect(vehicleStates({ ...taxi, available: false }, NONE)).toEqual(["route", "off"]);
  });

  it("combines depots, types and states (any state chosen), and hides the free vehicles", () => {
    const ids = (filter: Partial<typeof EMPTY_FILTER>, issues = NONE) =>
      filterRows(vehicles, { ...EMPTY_FILTER, ...filter }, issues).map((v) => v.id);
    expect(ids({})).toEqual(["taxi-1", "vsl-1", "amb-1", "vsl-2"]);
    expect(ids({ depots: ["depot-manosque"] })).toEqual(["vsl-2"]);
    expect(ids({ types: ["VSL"] })).toEqual(["vsl-1", "vsl-2"]);
    expect(ids({ types: ["VSL"], depots: ["depot-marseille"] })).toEqual(["vsl-1"]);
    expect(ids({ states: ["route", "off"] })).toEqual(["taxi-1", "vsl-2"]);
    expect(ids({ states: ["issue"] }, new Set(["amb-1"]))).toEqual(["amb-1"]);
    expect(ids({ hideFree: true })).toEqual(["taxi-1", "vsl-2"]);
    expect(matchesFilter(ambulance, { ...EMPTY_FILTER, hideFree: true }, NONE)).toBe(false);
  });

  it("keeps the selected vehicle whatever the filter", () => {
    expect(filterRows(vehicles, { ...EMPTY_FILTER, types: ["TAXI"] }, NONE, "amb-1").map((v) => v.id)).toEqual(["taxi-1", "amb-1"]);
  });

  it("finds the vehicles with something to handle, as « À traiter » lists them", () => {
    const { trips } = planningFixture();
    const onVsl = { ...trips, "trip-v": tripView({ id: "trip-v", vehicleId: "vsl-1" }), "trip-r": tripView({ id: "trip-r", vehicleId: "amb-1" }) };
    const ids = issueVehicleIds({
      trips: onVsl,
      violations: [
        { code: "TIME_WINDOW", label: "", message: "", tripId: "trip-a", vehicleId: null },
        { code: "SHIFT", label: "", message: "", tripId: null, vehicleId: "vsl-2" },
      ],
      vehicleIssues: [{ vehicleId: "x-1" }],
      staleTrips: [{ tripId: "trip-v" }],
      returnsToCheck: ["trip-r", "trip-c"],
    });
    expect([...ids].sort()).toEqual(["amb-1", "taxi-1", "vsl-1", "vsl-2", "x-1"]);
  });
});

describe("depot groups and their subtotals", () => {
  it("groups by depot alphabetically, counting the whole fleet of each depot", () => {
    const { vehicles } = planningFixture();
    const groups = groupByDepot(vehicles.slice(0, 2), vehicles);
    expect(groups.map((g) => [g.id, g.rows.map((r) => r.id), g.fleet])).toEqual([["depot-marseille", ["taxi-1", "vsl-1"], 3]]);
    expect(depotChoices(vehicles)).toEqual([
      { id: "depot-manosque", label: "Manosque", count: 1 },
      { id: "depot-marseille", label: "Marseille", count: 3 },
    ]);
  });

  it("sums trips, km, empty share and margin of the rows shown, and their locked trips", () => {
    const { vehicles, trips } = planningFixture();
    const locked = { ...trips, "trip-b": { ...trips["trip-b"]!, lockedVehicleId: "taxi-1" } };
    const [manosque, marseille] = depotGroupViews("2026-11-10", vehicles, vehicles, Object.values(locked), locked);
    expect(manosque).toMatchObject({ label: "Manosque", totals: { tripsServed: 0, totalKm: 0, emptyKmRatio: null, margin: 0 }, locked: 0 });
    expect(marseille).toMatchObject({ label: "Marseille", totals: { tripsServed: 2, totalKm: 18.4, margin: -3.7 }, locked: 1 });
    expect(marseille?.totals.emptyKmRatio).toBeCloseTo(6.2 / 18.4);
  });

  it("counts the trips a route lock would change", () => {
    const { vehicles, trips } = planningFixture();
    const taxi = vehicles[0]!;
    expect(lockableTripCount(taxi, trips)).toBe(2);
    const one = { ...trips, "trip-a": { ...trips["trip-a"]!, lockedVehicleId: "taxi-1" } };
    expect([lockedTripCount(taxi, one), lockableTripCount(taxi, one)]).toEqual([1, 1]);
    const cancelled = { ...trips, "trip-b": { ...trips["trip-b"]!, status: "CANCELLED" as const } };
    expect(lockableTripCount(taxi, cancelled)).toBe(1);
    expect(lockableTripCount(vehicles[1]!, trips)).toBe(0);
  });
});

describe("indicators of the vehicles shown", () => {
  it("are the day's indicators (same formulas) when every vehicle is shown", () => {
    const { vehicles, trips } = planningFixture();
    const list = Object.values(trips);
    const subset = subsetKpis("2026-11-10", vehicles, list, []);
    // The same day read as /planning reads it from the database (view.ts).
    const route = vehicles[0]!.route!;
    const routes: KpiRouteSource[] = [
      {
        vehicleId: "taxi-1",
        distanceKm: route.distanceKm,
        emptyKm: route.emptyKm,
        revenue: route.revenue,
        cost: route.cost,
        margin: route.margin,
        validatedAt: null,
        stops: route.stops.map((s) => ({ tripId: s.tripId, kind: s.kind, completedAt: null })),
      },
    ];
    const tripRows: KpiTripSource[] = list.map((t) => ({
      id: t.id,
      status: t.status,
      routeId: t.vehicleId ? route.id : null,
      direction: t.direction,
      shared: t.shared,
      appointmentMinute: t.appointmentMinute,
      plannedDropoffMinute: t.plannedDropoffMinute,
    }));
    const day = computeDayKpis("2026-11-10", tripRows, routes, 0);
    expect({ ...subset, tripsTotal: day.tripsTotal }).toEqual(day);
  });

  it("count only the trips and violations of the vehicles shown", () => {
    const { vehicles, trips } = planningFixture();
    const violations = [
      { code: "TIME_WINDOW", label: "", message: "", tripId: "trip-a", vehicleId: null },
      { code: "SHIFT", label: "", message: "", tripId: null, vehicleId: "vsl-1" },
      { code: "TIME_WINDOW", label: "", message: "", tripId: "trip-c", vehicleId: null },
    ];
    const vsl = subsetKpis("2026-11-10", [vehicles[1]!], Object.values(trips), violations);
    expect(vsl).toMatchObject({ tripsServed: 0, tripsTotal: 0, vehiclesUsed: 0, totalKm: 0, violations: 1 });
    const taxi = subsetKpis("2026-11-10", [vehicles[0]!], Object.values(trips), violations);
    expect(taxi).toMatchObject({ tripsServed: 2, vehiclesUsed: 1, sharedTrips: 2, violations: 1 });
  });
});
