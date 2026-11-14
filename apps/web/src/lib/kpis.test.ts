import { describe, expect, it } from "vitest";
import {
  computeDayKpis,
  DEFAULT_KPI_OPTIONS,
  computeKpisByDay,
  dayCount,
  deltaTrend,
  kpiDelta,
  listDates,
  MAX_AGGREGATED_RANGE_DAYS,
  MAX_RANGE_DAYS,
  minuteOfServiceDay,
  mixedDistanceSources,
  pickHeadlineDays,
  resolveLateTolerance,
  ratio,
  resolveKpiRange,
  summarizePeriod,
  type DayKpis,
  type KpiData,
  type KpiOptions,
  type KpiRoute,
  type KpiRun,
  type KpiTrip,
} from "./kpis";

// November 2026: Europe/Paris is UTC+1.
const DAY = "2026-11-03";
const TODAY = "2026-11-04";

/** Real instant at local Paris time `hhmm` (seconds optional) on `date`. */
function paris(date: string, hhmm: string, offset = "+01:00"): Date {
  const time = hhmm.length === 5 ? `${hhmm}:00` : hhmm;
  return new Date(`${date}T${time}${offset}`);
}

function route(overrides: Partial<KpiRoute> = {}): KpiRoute {
  return {
    id: "r1",
    vehicleType: "TAXI",
    serviceDate: DAY,
    vehicleId: "v1",
    distanceKm: 100,
    emptyKm: 20,
    revenue: 300,
    cost: 120,
    margin: 180,
    validatedAt: null,
    stopCount: 4,
    hasRecordedStatus: true,
    ...overrides,
  };
}

function trip(overrides: Partial<KpiTrip> = {}): KpiTrip {
  return {
    serviceDate: DAY,
    status: "ASSIGNED",
    routeId: "r1",
    direction: "OUTBOUND",
    shared: false,
    appointmentMinute: 450,
    plannedDropoffMinute: 440,
    dropoffCompletedAt: null,
    ...overrides,
  };
}

function run(startedAt: Date, serviceDate = DAY): KpiRun {
  return { serviceDate, startedAt };
}

function day(rows: Partial<KpiData>, date = DAY, today = TODAY, options?: Partial<KpiOptions>) {
  return computeDayKpis(
    date,
    { routes: rows.routes ?? [], trips: rows.trips ?? [], runs: rows.runs ?? [], fleet: rows.fleet, plans: rows.plans },
    today,
    { ...DEFAULT_KPI_OPTIONS, ...options },
  );
}

describe("helpers", () => {
  it("ratio returns null instead of dividing by zero", () => {
    expect(ratio(3, 4)).toBe(0.75);
    expect(ratio(0, 4)).toBe(0);
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(5, 0)).toBeNull();
    expect(ratio(Number.NaN, 2)).toBeNull();
  });

  it("lists inclusive dates across a month boundary", () => {
    expect(listDates("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(listDates(DAY, DAY)).toEqual([DAY]);
    expect(listDates("2026-11-05", DAY)).toEqual([]);
    expect(dayCount("2026-10-30", "2026-11-02")).toBe(4);
    // Daylight saving change (25 October 2026) does not shift the count.
    expect(dayCount("2026-10-20", "2026-10-30")).toBe(11);
  });

  it("converts a real instant into a minute of the service day (Europe/Paris)", () => {
    expect(minuteOfServiceDay(paris(DAY, "07:30"), DAY)).toBe(450);
    expect(minuteOfServiceDay(paris(DAY, "07:30:59"), DAY)).toBe(450);
    // After midnight the minute keeps counting from the service day.
    expect(minuteOfServiceDay(paris("2026-11-04", "00:10"), DAY)).toBe(1450);
    // Summer time (UTC+2).
    expect(minuteOfServiceDay(new Date("2026-07-01T05:30:00Z"), "2026-07-01")).toBe(450);
  });
});

describe("computeDayKpis", () => {
  it("counts the served seated trips carried by an ambulance as an exceptional measure", () => {
    const kpis = day({
      trips: [
        trip({ exceptionalAmbulance: true }),
        trip({ exceptionalAmbulance: true, status: "CANCELLED" }),
        trip({ exceptionalAmbulance: false }),
        trip(),
      ],
    });
    expect(kpis.exceptionalAmbulanceTrips).toBe(1);
    expect(summarizePeriod([kpis, kpis]).exceptionalAmbulanceTrips).toBe(2);
  });

  it("handles a day without any route, trip or run", () => {
    const kpis = day({});
    expect(kpis).toMatchObject({
      date: DAY,
      upcoming: false,
      vehicles: 0,
      servedTrips: 0,
      realizedTrips: 0,
      distanceKm: 0,
      emptyKm: 0,
      optimizationRuns: 0,
      revenue: 0,
      cost: 0,
      margin: 0,
      tripsPerVehiclePlanned: null,
      tripsPerVehicleRealized: null,
      emptyKmShare: null,
      eligibleSharedRate: null,
      measuredSharedRate: null,
      lateRate: null,
      serviceRate: null,
      useRate: null,
      maxDelayMinutes: null,
      planningStatus: "NONE",
      frozen: null,
      fleet: null,
      firstRunAt: null,
      validatedAt: null,
      planningMinutes: null,
    });
  });

  it("ignores rows of other dates", () => {
    const kpis = day({
      routes: [route({ serviceDate: "2026-11-02" })],
      trips: [trip({ serviceDate: "2026-11-02" })],
      runs: [run(paris("2026-11-01", "18:00"), "2026-11-02")],
    });
    expect(kpis.vehicles).toBe(0);
    expect(kpis.servedTrips).toBe(0);
    expect(kpis.optimizationRuns).toBe(0);
  });

  describe("1. courses facturées par véhicule", () => {
    const routes = [route({ vehicleId: "v1" }), route({ vehicleId: "v2" })];
    const trips = [
      trip({ status: "ASSIGNED" }),
      trip({ status: "PICKED_UP" }),
      trip({ status: "DROPPED_OFF" }),
      trip({ status: "DROPPED_OFF", direction: "RETURN", appointmentMinute: null }),
      trip({ status: "ASSIGNED", routeId: "r2" }),
      // Not served: unassigned, cancelled, absent, or without route.
      trip({ status: "PLANNED", routeId: null }),
      trip({ status: "CANCELLED" }),
      trip({ status: "NO_SHOW" }),
      trip({ status: "ASSIGNED", routeId: null }),
      trip({ status: "DROPPED_OFF", routeId: null }),
    ];

    it("divides served trips by vehicles with a route (planned) and dropped-off trips (realized)", () => {
      const kpis = day({ routes, trips });
      expect(kpis.vehicles).toBe(2);
      expect(kpis.servedTrips).toBe(5);
      expect(kpis.realizedTrips).toBe(2);
      expect(kpis.tripsPerVehiclePlanned).toBe(2.5);
      expect(kpis.tripsPerVehicleRealized).toBe(1);
    });

    it("has no realized value for an upcoming day", () => {
      const kpis = day({ routes, trips }, DAY, "2026-11-02");
      expect(kpis.upcoming).toBe(true);
      expect(kpis.tripsPerVehiclePlanned).toBe(2.5);
      expect(kpis.tripsPerVehicleRealized).toBeNull();
      expect(kpis.realizedVehicles).toBe(0);
    });

    it("counts today as started but in progress", () => {
      const kpis = day({ routes, trips }, DAY, DAY);
      expect(kpis.upcoming).toBe(false);
      expect(kpis.inProgress).toBe(true);
      expect(kpis.tripsPerVehicleRealized).toBe(1);
      expect(day({ routes, trips }).inProgress).toBe(false);
    });

    it("gives 0 realized trips per vehicle when crews recorded statuses but nothing was dropped off", () => {
      const kpis = day({ routes, trips: [trip({ status: "ASSIGNED" }), trip({ status: "PICKED_UP" })] });
      expect(kpis.realizedTrips).toBe(0);
      expect(kpis.realizedVehicles).toBe(2);
      expect(kpis.tripsPerVehicleRealized).toBe(0);
      expect(kpis.lateRate).toBeNull();
    });

    it("has no realized value on a past day where no crew recorded a status", () => {
      const kpis = day({
        routes: [route({ vehicleId: "v1", hasRecordedStatus: false }), route({ vehicleId: "v2", hasRecordedStatus: false })],
        trips: [trip({ status: "ASSIGNED" }), trip({ status: "ASSIGNED", routeId: "r2" })],
      });
      expect(kpis.vehicles).toBe(2);
      expect(kpis.tripsPerVehiclePlanned).toBe(1);
      expect(kpis.realizedVehicles).toBe(0);
      expect(kpis.tripsPerVehicleRealized).toBeNull();
    });

    it("divides realized trips by the vehicles whose crew recorded a status only", () => {
      const kpis = day({
        routes: [route({ vehicleId: "v1" }), route({ vehicleId: "v2", hasRecordedStatus: false })],
        trips: [trip({ status: "DROPPED_OFF" }), trip({ status: "DROPPED_OFF" }), trip({ status: "ASSIGNED", routeId: "r2" })],
      });
      expect(kpis.vehicles).toBe(2);
      expect(kpis.realizedVehicles).toBe(1);
      expect(kpis.tripsPerVehicleRealized).toBe(2);
    });

    it("leaves out routes emptied by cancellations (vehicle, km and money), like /planning", () => {
      const kpis = day({
        routes: [
          route({ vehicleId: "a", distanceKm: 100, emptyKm: 20, revenue: 300, cost: 120, margin: 180 }),
          route({ vehicleId: "b", distanceKm: 100, emptyKm: 20, revenue: 300, cost: 120, margin: 180 }),
          // Its only trip was cancelled: the row keeps its stale totals but has no stop left.
          route({ vehicleId: "c", stopCount: 0, distanceKm: 50, emptyKm: 30, revenue: 90, cost: 40, margin: 50 }),
        ],
        trips: Array.from({ length: 11 }, (_, i) => trip({ routeId: i % 2 === 0 ? "ra" : "rb" })),
      });
      expect(kpis.vehicles).toBe(2);
      expect(kpis.tripsPerVehiclePlanned).toBe(5.5);
      expect(kpis).toMatchObject({ distanceKm: 200, emptyKm: 40, revenue: 600, cost: 240, margin: 360 });
      expect(kpis.emptyKmShare).toBe(0.2);
      expect(kpis.realizedVehicles).toBe(2);
    });

    it("still reads the planning status from emptied routes", () => {
      const validated = paris("2026-11-02", "18:30");
      const proposedLeftover = day({
        routes: [route({ validatedAt: validated }), route({ vehicleId: "v2", stopCount: 0, validatedAt: null })],
      });
      expect(proposedLeftover.planningStatus).toBe("NOT_VALIDATED");
      const onlyEmptied = day({
        routes: [route({ stopCount: 0, validatedAt: validated })],
        runs: [run(paris("2026-11-02", "18:00"))],
      });
      expect(onlyEmptied.vehicles).toBe(0);
      expect(onlyEmptied.tripsPerVehiclePlanned).toBeNull();
      expect(onlyEmptied.planningStatus).toBe("VALIDATED");
      expect(onlyEmptied.clockMinutes).toBe(30);
    });

    it("counts each vehicle once", () => {
      const kpis = day({ routes: [route({ vehicleId: "v1" }), route({ vehicleId: "v1" })], trips: [trip(), trip()] });
      expect(kpis.vehicles).toBe(1);
      expect(kpis.tripsPerVehiclePlanned).toBe(2);
    });

    it("has no value without vehicles even if trips are served", () => {
      expect(day({ trips: [trip()] }).tripsPerVehiclePlanned).toBeNull();
    });
  });

  describe("2. part des km à vide", () => {
    it("is the sum of empty km over the sum of km, not an average of route shares", () => {
      const kpis = day({
        routes: [route({ distanceKm: 100, emptyKm: 10 }), route({ vehicleId: "v2", distanceKm: 50, emptyKm: 20 })],
      });
      expect(kpis.distanceKm).toBe(150);
      expect(kpis.emptyKm).toBe(30);
      expect(kpis.emptyKmShare).toBeCloseTo(0.2);
    });

    it("is null when no km are planned", () => {
      expect(day({ routes: [route({ distanceKm: 0, emptyKm: 0 })] }).emptyKmShare).toBeNull();
    });

    it("sums money of the routes", () => {
      const kpis = day({
        routes: [route({ revenue: 300, cost: 120, margin: 180 }), route({ vehicleId: "v2", revenue: 50, cost: 80, margin: -30 })],
      });
      expect(kpis).toMatchObject({ revenue: 350, cost: 200, margin: 150 });
    });
  });

  describe("3. taux de transport partagé (périmètre de l'Assurance maladie)", () => {
    it("counts the eligible CPAM trips in a taxi or a VSL only, apart", () => {
      const eligible = (overrides: Partial<KpiTrip> = {}) => trip({ sharingAllowed: true, ...overrides });
      const kpis = day({
        routes: [route(), route({ id: "r2", vehicleId: "v2", vehicleType: "VSL" }), route({ id: "r3", vehicleId: "v3", vehicleType: "AMBULANCE" })],
        trips: [
          eligible({ shared: true }),
          eligible({ shared: false }),
          eligible({ routeId: "r2", shared: true }),
          // Not eligible: the prescription does not allow it, a private client, an ambulance, not served.
          trip({ shared: false, sharingAllowed: false }),
          eligible({ shared: true, payer: "PRIVATE" }),
          eligible({ routeId: "r3", shared: false }),
          eligible({ shared: true, status: "CANCELLED" }),
        ],
      });
      // Every served trip with a co-passenger, whatever its scope (the planning's flag).
      expect(kpis.sharedTrips).toBe(3);
      expect(kpis.sharing.eligible).toEqual({ TAXI: 2, VSL: 1 });
      expect(kpis.sharing.eligibleShared).toEqual({ TAXI: 1, VSL: 1 });
      expect(kpis.sharing.tap).toEqual({ TAXI: 3, VSL: 1 });
      expect(kpis.eligibleSharedRate).toBeCloseTo(2 / 3);
    });

    it("is null without eligible trips", () => {
      expect(day({ routes: [route()], trips: [trip({ shared: true })] }).eligibleSharedRate).toBeNull();
    });
  });

  describe("4. patients arrivés après l'heure du RDV", () => {
    const realized = (hhmm: string, overrides: Partial<KpiTrip> = {}) =>
      trip({ status: "DROPPED_OFF", appointmentMinute: 450, dropoffCompletedAt: paris(DAY, hhmm), ...overrides });

    it("counts a patient dropped off 1 minute after the appointment as late without tolerance", () => {
      const kpis = day({ routes: [route()], trips: [realized("07:31")] }, DAY, TODAY, { lateToleranceMin: 0 });
      expect(kpis.realizedOutbound).toBe(1);
      expect(kpis.measuredOutbound).toBe(1);
      expect(kpis.lateArrivals).toBe(1);
      expect(kpis.maxDelayMinutes).toBe(1);
      expect(kpis.lateRate).toBe(1);
    });

    it("counts a drop-off within the appointment minute as on time", () => {
      const kpis = day({ routes: [route()], trips: [realized("07:30"), realized("07:30:59"), realized("07:05")] }, DAY, TODAY, {
        lateToleranceMin: 0,
      });
      expect(kpis.measuredOutbound).toBe(3);
      expect(kpis.lateArrivals).toBe(0);
      expect(kpis.lateRate).toBe(0);
      expect(kpis.maxDelayMinutes).toBeNull();
    });

    it("applies the tolerance (5 min by default) and counts the bands beyond 5 and 15 min whatever it is", () => {
      const trips = [realized("07:33"), realized("07:35"), realized("07:36"), realized("07:46"), realized("07:20")];
      const kpis = day({ routes: [route()], trips });
      expect(kpis.lateArrivals).toBe(2);
      expect(kpis.lateOver5).toBe(2);
      expect(kpis.lateOver15).toBe(1);
      expect(kpis.maxDelayMinutes).toBe(16);
      expect(kpis.lateRate).toBeCloseTo(2 / 5);
      const strict = day({ routes: [route()], trips }, DAY, TODAY, { lateToleranceMin: 0 });
      expect(strict.lateArrivals).toBe(4);
      expect(strict.lateOver5).toBe(2);
    });

    it("rates late arrivals over measured realized outbound trips only", () => {
      const kpis = day({
        routes: [route()],
        trips: [
          realized("07:45"),
          realized("07:20"),
          realized("07:52", { appointmentMinute: 480 }),
          // Realized but no drop-off time recorded: not measurable.
          trip({ status: "DROPPED_OFF", dropoffCompletedAt: null }),
          // Return legs, unrealized trips and unserved trips are out of scope.
          realized("09:00", { direction: "RETURN", appointmentMinute: null }),
          trip({ status: "PICKED_UP", dropoffCompletedAt: null }),
          realized("08:00", { routeId: null }),
        ],
      }, DAY, TODAY, { lateToleranceMin: 0 });
      expect(kpis.realizedOutbound).toBe(4);
      expect(kpis.measuredOutbound).toBe(3);
      expect(kpis.lateArrivals).toBe(1);
      expect(kpis.maxDelayMinutes).toBe(15);
      expect(kpis.lateRate).toBeCloseTo(1 / 3);
    });

    it("measures a drop-off after midnight against the service day", () => {
      const kpis = day({
        routes: [route()],
        trips: [trip({ status: "DROPPED_OFF", appointmentMinute: 1430, dropoffCompletedAt: paris("2026-11-04", "00:05") })],
      });
      // 15 minutes late: beyond the default tolerance.
      expect(kpis.lateArrivals).toBe(1);
      expect(kpis.maxDelayMinutes).toBe(15);
    });

    it("counts the outbound trips planned less than the margin before the appointment (« serrés »)", () => {
      const kpis = day({
        routes: [route()],
        trips: [
          trip({ plannedDropoffMinute: 448 }),
          trip({ plannedDropoffMinute: 445 }),
          trip({ plannedDropoffMinute: 420, status: "DROPPED_OFF" }),
          trip({ plannedDropoffMinute: null }),
          trip({ direction: "RETURN", appointmentMinute: null, plannedDropoffMinute: 900 }),
        ],
      });
      expect(kpis.plannedOutbound).toBe(3);
      expect(kpis.tightOutbound).toBe(1);
      expect(kpis.tightRate).toBeCloseTo(1 / 3);
      expect(day({ routes: [route()], trips: [trip({ plannedDropoffMinute: 440 })] }, DAY, TODAY, { tightMarginMin: 15 }).tightOutbound).toBe(1);
    });

    it("has no late rate when no realized trip was measured", () => {
      const kpis = day({ routes: [route()], trips: [trip({ status: "ASSIGNED" })] });
      expect(kpis.measuredOutbound).toBe(0);
      expect(kpis.lateArrivals).toBe(0);
      expect(kpis.lateRate).toBeNull();
    });
  });

  describe("5. temps passé à construire le planning", () => {
    it("keeps the wall clock from the first optimization to the last validation, over multiple runs", () => {
      const kpis = day({
        routes: [
          route({ validatedAt: paris("2026-11-02", "18:45") }),
          route({ vehicleId: "v2", validatedAt: paris("2026-11-02", "18:50") }),
        ],
        runs: [run(paris("2026-11-02", "18:20")), run(paris("2026-11-02", "18:00")), run(paris("2026-11-02", "18:35"))],
      });
      expect(kpis.optimizationRuns).toBe(3);
      expect(kpis.firstRunAt).toEqual(paris("2026-11-02", "18:00"));
      expect(kpis.validatedAt).toEqual(paris("2026-11-02", "18:50"));
      expect(kpis.planningStatus).toBe("VALIDATED");
      expect(kpis.clockMinutes).toBe(50);
    });

    it("is not validated while one route is still proposed", () => {
      const kpis = day({
        routes: [route({ validatedAt: paris("2026-11-02", "18:45") }), route({ vehicleId: "v2", validatedAt: null })],
        runs: [run(paris("2026-11-02", "18:00"))],
      });
      expect(kpis.planningStatus).toBe("NOT_VALIDATED");
      expect(kpis.validatedAt).toBeNull();
      expect(kpis.clockMinutes).toBeNull();
    });

    it("is not validated when optimizations ran but produced no route", () => {
      const kpis = day({ runs: [run(paris("2026-11-02", "18:00")), run(paris("2026-11-02", "18:05"))] });
      expect(kpis.optimizationRuns).toBe(2);
      expect(kpis.planningStatus).toBe("NOT_VALIDATED");
      expect(kpis.clockMinutes).toBeNull();
    });

    it("cannot be measured for a validated day without optimization run", () => {
      const kpis = day({ routes: [route({ validatedAt: paris("2026-11-02", "18:45") })] });
      expect(kpis.planningStatus).toBe("VALIDATED");
      expect(kpis.firstRunAt).toBeNull();
      expect(kpis.clockMinutes).toBeNull();
    });

    it("ignores a validation older than the first run", () => {
      const kpis = day({
        routes: [route({ validatedAt: paris("2026-11-02", "17:00") })],
        runs: [run(paris("2026-11-02", "18:00"))],
      });
      expect(kpis.planningStatus).toBe("VALIDATED");
      expect(kpis.clockMinutes).toBeNull();
    });

    it("keeps fractions of minutes", () => {
      const kpis = day({
        routes: [route({ validatedAt: new Date("2026-11-02T17:10:30Z") })],
        runs: [run(new Date("2026-11-02T17:00:00Z"))],
      });
      expect(kpis.clockMinutes).toBe(10.5);
    });

    it("measures the active time of the initial build from the planning actions", () => {
      const at = (hhmm: string, date = "2026-11-02") => paris(date, hhmm);
      const kpis = computeDayKpis(
        DAY,
        {
          routes: [route({ validatedAt: at("06:55", DAY) })],
          trips: [],
          runs: [{ serviceDate: DAY, startedAt: at("17:00"), requestedById: "u1" }],
          activity: [
            { serviceDate: DAY, at: at("17:02"), action: "plan.optimize", userId: "u1" },
            { serviceDate: DAY, at: at("17:20"), action: "plan.validate", userId: "u1" },
            // Reopened on the day itself for a call, validated again.
            { serviceDate: DAY, at: at("06:45", DAY), action: "plan.reopen", userId: "u1" },
            { serviceDate: DAY, at: at("06:55", DAY), action: "plan.validate", userId: "u1" },
            { serviceDate: "2026-11-04", at: at("18:00", DAY), action: "plan.optimize", userId: "u1" },
          ],
        },
        TODAY,
      );
      // 17:00 → 17:02 → 17:20 would be one session only if the 18 min gap were under 15 min: two sessions of 2 and 1 min.
      expect(kpis.planningMinutes).toBe(3);
      expect(kpis.planningTime?.touchUpMinutes).toBe(10);
      expect(kpis.clockMinutes).toBe(13 * 60 + 55);
    });
  });
});

describe("computeKpisByDay", () => {
  it("returns every date of the range, empty days included, oldest first", () => {
    const data: KpiData = {
      routes: [route({ serviceDate: "2026-11-02" }), route({ serviceDate: "2026-11-04", vehicleId: "v9" })],
      trips: [trip({ serviceDate: "2026-11-02" }), trip({ serviceDate: "2026-11-04" }), trip({ serviceDate: "2026-11-04" })],
      runs: [run(paris("2026-11-01", "18:00"), "2026-11-02"), run(paris("2026-10-20", "18:00"), "2026-10-21")],
    };
    const days = computeKpisByDay("2026-11-01", "2026-11-04", data, "2026-11-03");
    expect(days.map((d) => d.date)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(days.map((d) => d.servedTrips)).toEqual([0, 1, 0, 2]);
    expect(days.map((d) => d.optimizationRuns)).toEqual([0, 1, 0, 0]);
    expect(days.map((d) => d.upcoming)).toEqual([false, false, false, true]);
    expect(days.map((d) => d.inProgress)).toEqual([false, false, true, false]);
    expect(days[2]?.tripsPerVehiclePlanned).toBeNull();
  });
});

describe("summarizePeriod", () => {
  it("recomputes rates from summed counters instead of averaging daily rates", () => {
    const data: KpiData = {
      routes: [
        route({ serviceDate: "2026-11-02", vehicleId: "a", distanceKm: 100, emptyKm: 50 }),
        route({ serviceDate: "2026-11-03", vehicleId: "a", distanceKm: 300, emptyKm: 30 }),
        route({ serviceDate: "2026-11-03", vehicleId: "b", distanceKm: 0, emptyKm: 0 }),
        route({ serviceDate: "2026-11-03", vehicleId: "c", distanceKm: 0, emptyKm: 0 }),
      ],
      trips: [
        trip({ serviceDate: "2026-11-02", status: "DROPPED_OFF" }),
        ...Array.from({ length: 9 }, () => trip({ serviceDate: "2026-11-03", shared: true, sharingAllowed: true })),
      ],
      runs: [],
    };
    const days = computeKpisByDay("2026-11-01", "2026-11-03", data, "2026-11-04");
    const period = summarizePeriod(days);
    expect(period).toMatchObject({
      from: "2026-11-01",
      to: "2026-11-03",
      days: 3,
      inProgressDate: null,
      plannedDays: 2,
      vehicles: 4,
      servedTrips: 10,
      realizedVehicles: 4,
      realizedTrips: 1,
    });
    expect(period.tripsPerVehiclePlanned).toBe(2.5); // 10 / 4, not (1 + 3) / 2
    expect(period.tripsPerVehicleRealized).toBe(0.25); // 1 / 4, not (1 + 0) / 2
    expect(period.emptyKmShare).toBeCloseTo(0.2); // 80 / 400, not (0.5 + 0.1) / 2
    expect(period.eligibleSharedRate).toBe(1);
  });

  it("leaves the day in progress, upcoming days and untracked crews out of the realized rate", () => {
    const dropped = (serviceDate: string, count: number) =>
      Array.from({ length: count }, () => trip({ serviceDate, status: "DROPPED_OFF" }));
    const assigned = (serviceDate: string, count: number) =>
      Array.from({ length: count }, () => trip({ serviceDate, status: "ASSIGNED" }));
    const data: KpiData = {
      routes: [
        // Before the roadmap was used: no status recorded.
        route({ serviceDate: "2026-10-31", vehicleId: "a", hasRecordedStatus: false }),
        route({ serviceDate: "2026-10-31", vehicleId: "b", hasRecordedStatus: false }),
        // Finished day: 5 drop-offs per vehicle.
        route({ serviceDate: "2026-11-01", vehicleId: "a" }),
        route({ serviceDate: "2026-11-01", vehicleId: "b" }),
        // Today at 10:00: 2 drop-offs so far, vehicle c not started.
        route({ serviceDate: "2026-11-02", vehicleId: "a" }),
        route({ serviceDate: "2026-11-02", vehicleId: "b" }),
        route({ serviceDate: "2026-11-02", vehicleId: "c", hasRecordedStatus: false }),
        // Tomorrow.
        route({ serviceDate: "2026-11-03", vehicleId: "a", hasRecordedStatus: false }),
        route({ serviceDate: "2026-11-03", vehicleId: "b", hasRecordedStatus: false }),
      ],
      trips: [
        ...assigned("2026-10-31", 8),
        ...dropped("2026-11-01", 10),
        ...dropped("2026-11-02", 2),
        ...assigned("2026-11-02", 8),
        ...assigned("2026-11-03", 6),
      ],
      runs: [],
    };
    const days = computeKpisByDay("2026-10-31", "2026-11-03", data, "2026-11-02");
    expect(days.map((d) => d.tripsPerVehicleRealized)).toEqual([null, 5, 1, null]);
    expect(days[2]).toMatchObject({ inProgress: true, vehicles: 3, realizedVehicles: 2, realizedTrips: 2 });

    const period = summarizePeriod(days);
    expect(period.inProgressDate).toBe("2026-11-02");
    expect(period).toMatchObject({ vehicles: 9, servedTrips: 34, realizedTrips: 10, realizedVehicles: 2 });
    // 10 / 2: neither 0 for the untracked day nor (10 + 2) / (2 + 3) with today's partial count.
    expect(period.tripsPerVehicleRealized).toBe(5);
    expect(period.tripsPerVehiclePlanned).toBeCloseTo(34 / 9);
  });

  it("averages planning time over measured days and keeps the largest delay", () => {
    const data: KpiData = {
      routes: [
        route({ serviceDate: "2026-11-02", validatedAt: paris("2026-11-01", "18:30") }),
        route({ serviceDate: "2026-11-03", validatedAt: paris("2026-11-02", "19:00") }),
        route({ serviceDate: "2026-11-04", validatedAt: null }),
      ],
      trips: [
        trip({ serviceDate: "2026-11-02", status: "DROPPED_OFF", dropoffCompletedAt: paris("2026-11-02", "07:40") }),
        trip({ serviceDate: "2026-11-03", status: "DROPPED_OFF", dropoffCompletedAt: paris("2026-11-03", "07:55") }),
        trip({ serviceDate: "2026-11-03", status: "DROPPED_OFF", dropoffCompletedAt: paris("2026-11-03", "07:00") }),
      ],
      runs: [
        run(paris("2026-11-01", "18:00"), "2026-11-02"),
        run(paris("2026-11-02", "18:00"), "2026-11-03"),
        run(paris("2026-11-02", "18:30"), "2026-11-03"),
        run(paris("2026-11-03", "18:00"), "2026-11-04"),
      ],
    };
    const period = summarizePeriod(computeKpisByDay("2026-11-02", "2026-11-04", data, "2026-11-03"));
    expect(period.validatedDays).toBe(2);
    // No action of the audit trail passed: the planning time is not measured (the wall clock is no longer it).
    expect(period.measuredPlanningDays).toBe(0);
    expect(period.medianPlanningMinutes).toBeNull();
    expect(period.optimizationRuns).toBe(4);
    expect(period.lateArrivals).toBe(2);
    expect(period.measuredOutbound).toBe(3);
    expect(period.maxDelayMinutes).toBe(25);
    expect(period.lateRate).toBeCloseTo(2 / 3);
  });

  it("leaves a day not optimized yet out of the demand and the sharing funnel", () => {
    const eligible = (serviceDate: string, overrides: Partial<KpiTrip> = {}) =>
      trip({ serviceDate, sharingAllowed: true, sharingStatus: "PROPOSED", ...overrides });
    const data: KpiData = {
      routes: [route({ serviceDate: "2026-11-03" })],
      trips: [
        eligible("2026-11-03", { shared: true }),
        eligible("2026-11-03", { shared: true }),
        // Tomorrow, not optimized yet: its trips are neither unassigned nor « never proposed ».
        eligible("2026-11-04", { status: "PLANNED", routeId: null, sharingStatus: "NOT_PROPOSED" }),
        eligible("2026-11-04", { status: "PLANNED", routeId: null, sharingStatus: "REFUSED", patientId: "p9" }),
      ],
      runs: [],
    };
    const days = computeKpisByDay("2026-11-03", "2026-11-04", data, "2026-11-03");
    expect(days[1]?.sharing.funnel.eligible).toBe(2);
    const period = summarizePeriod(days);
    expect(period.demand.requested).toBe(2);
    expect(period.sharing.funnel).toEqual({ eligible: 2, proposed: 2, accepted: 0, refused: 0 });
    expect(period.sharing.refusingPatientIds).toEqual([]);
  });

  it("summarizes an empty period without dividing by zero", () => {
    const period = summarizePeriod(computeKpisByDay("2026-11-01", "2026-11-02", { routes: [], trips: [], runs: [] }, TODAY));
    expect(period).toMatchObject({
      days: 2,
      inProgressDate: null,
      plannedDays: 0,
      tripsPerVehiclePlanned: null,
      tripsPerVehicleRealized: null,
      emptyKmShare: null,
      eligibleSharedRate: null,
      serviceRate: null,
      lateRate: null,
      medianPlanningMinutes: null,
    });
    expect(summarizePeriod([])).toMatchObject({ from: "", to: "", days: 0, medianPlanningMinutes: null });
  });
});

describe("resolveKpiRange", () => {
  const tomorrow = "2026-11-03";

  it("defaults to the 14 days ending tomorrow", () => {
    const byDay = { granularity: "day", explicitGranularity: false, error: null };
    expect(resolveKpiRange({}, tomorrow)).toEqual({ from: "2026-10-21", to: tomorrow, ...byDay });
    expect(resolveKpiRange({ from: "", to: "  " }, tomorrow)).toEqual({ from: "2026-10-21", to: tomorrow, ...byDay });
  });

  it("keeps a valid range and derives a missing start from the end", () => {
    expect(resolveKpiRange({ from: "2026-10-01", to: "2026-10-31" }, tomorrow)).toMatchObject({
      from: "2026-10-01",
      to: "2026-10-31",
      error: null,
    });
    expect(resolveKpiRange({ to: "2026-10-31" }, tomorrow)).toMatchObject({ from: "2026-10-18", to: "2026-10-31", error: null });
  });

  it("falls back on invalid dates with a message", () => {
    const range = resolveKpiRange({ from: "2026-02-30", to: "demain" }, tomorrow);
    expect(range.from).toBe("2026-10-21");
    expect(range.to).toBe(tomorrow);
    expect(range.error).toContain("Date de fin invalide");
    expect(range.error).toContain("Date de début invalide");
  });

  it("swaps a reversed range", () => {
    const range = resolveKpiRange({ from: "2026-11-10", to: "2026-11-01" }, tomorrow);
    expect(range).toMatchObject({ from: "2026-11-01", to: "2026-11-10" });
    expect(range.error).toContain("inversées");
  });

  it("limits a range shown day by day to MAX_RANGE_DAYS", () => {
    const range = resolveKpiRange({ from: "2025-01-01", to: "2026-11-03", granularity: "jour" }, tomorrow);
    expect(range.to).toBe("2026-11-03");
    expect(dayCount(range.from, range.to)).toBe(MAX_RANGE_DAYS);
    expect(range).toMatchObject({ granularity: "day", explicitGranularity: true });
    expect(range.error).toContain(`${MAX_RANGE_DAYS} jours`);
  });

  it("raises the limit by week or month, and picks the step of a long range itself", () => {
    expect(resolveKpiRange({ from: "2026-07-01", to: "2026-11-03" }, tomorrow)).toMatchObject({ granularity: "week", error: null });
    const year = resolveKpiRange({ from: "2025-11-01", to: "2026-11-03" }, tomorrow);
    expect(year).toMatchObject({ from: "2025-11-01", granularity: "month", explicitGranularity: false, error: null });
    const tooLong = resolveKpiRange({ from: "2024-01-01", to: "2026-11-03", granularity: "semaine" }, tomorrow);
    expect(dayCount(tooLong.from, tooLong.to)).toBe(MAX_AGGREGATED_RANGE_DAYS);
    expect(tooLong.granularity).toBe("week");
    expect(tooLong.error).toContain(`${MAX_AGGREGATED_RANGE_DAYS} jours`);
    // An unknown step falls back on the automatic one.
    expect(resolveKpiRange({ granularity: "trimestre" }, tomorrow)).toMatchObject({ granularity: "day", explicitGranularity: false });
  });
});

describe("pickHeadlineDays", () => {
  const data: KpiData = {
    routes: [
      route({ serviceDate: "2026-10-30" }),
      route({ serviceDate: "2026-11-02" }),
      route({ serviceDate: "2026-11-03" }),
    ],
    trips: [],
    // 2026-11-05 only has a failed optimization run.
    runs: [run(paris("2026-11-04", "18:00"), "2026-11-05")],
  };
  // Today is Wednesday 4 November; tomorrow Thursday 5.
  const days = computeKpisByDay("2026-10-28", "2026-11-05", data, "2026-11-04");
  const window = { from: "2026-11-01", to: "2026-11-05", today: "2026-11-04", tomorrow: "2026-11-05" };

  it("shows the last day done with routes and tomorrow", () => {
    const { realized, planned } = pickHeadlineDays(days, window);
    expect(realized?.date).toBe("2026-11-03");
    expect(planned?.date).toBe("2026-11-05");
  });

  it("puts a requested day in the block of its kind", () => {
    expect(pickHeadlineDays(days, { ...window, requested: "2026-11-02" })).toMatchObject({
      realized: { date: "2026-11-02" },
      planned: { date: "2026-11-05" },
    });
    // Today is shown as done (in progress).
    expect(pickHeadlineDays(days, { ...window, requested: "2026-11-04" }).realized?.date).toBe("2026-11-04");
  });

  it("ignores a requested day outside the visible range", () => {
    expect(pickHeadlineDays(days, { ...window, requested: "2026-10-30" }).realized?.date).toBe("2026-11-03");
  });

  it("has no planned day when the range ends before tomorrow, and no day done when nothing ran", () => {
    expect(pickHeadlineDays(days, { ...window, to: "2026-11-03" }).planned).toBeNull();
    const empty = computeKpisByDay("2026-11-01", "2026-11-05", { routes: [], trips: [], runs: [] }, "2026-11-04");
    expect(pickHeadlineDays(empty, window)).toMatchObject({ realized: null, planned: { date: "2026-11-05" } });
    expect(pickHeadlineDays([], window)).toEqual({ realized: null, planned: null });
  });
});

describe("resolveLateTolerance", () => {
  it("keeps an offered tolerance and falls back on 5 minutes", () => {
    expect(resolveLateTolerance("0")).toBe(0);
    expect(resolveLateTolerance("15")).toBe(15);
    expect(resolveLateTolerance("7")).toBe(5);
    expect(resolveLateTolerance("abc")).toBe(5);
    expect(resolveLateTolerance("")).toBe(5);
    expect(resolveLateTolerance(undefined)).toBe(5);
  });
});

describe("comparison", () => {
  it("computes deltas only when both values are known", () => {
    expect(kpiDelta(4.5, 4)).toBe(0.5);
    expect(kpiDelta(null, 4)).toBeNull();
    expect(kpiDelta(4, null)).toBeNull();
  });

  it("reads a change as better or worse depending on the indicator", () => {
    expect(deltaTrend(0.5, true)).toBe("better");
    expect(deltaTrend(0.5, false)).toBe("worse");
    expect(deltaTrend(-0.02, false)).toBe("better");
    expect(deltaTrend(0, true)).toBe("same");
    expect(deltaTrend(null, true)).toBeNull();
  });
});

describe("distance sources", () => {
  it("lists the sources of each day's routes and of the period, so a mixed period shows", () => {
    const data: KpiData = {
      routes: [
        route({ serviceDate: "2026-11-02", vehicleId: "a", matrixSource: "haversine" }),
        route({ serviceDate: "2026-11-03", vehicleId: "a", matrixSource: "osrm" }),
        route({ serviceDate: "2026-11-03", vehicleId: "b", matrixSource: "osrm" }),
        // A route emptied by cancellations does not count, nor a route of unknown source.
        route({ serviceDate: "2026-11-03", vehicleId: "c", matrixSource: "mixed", stopCount: 0 }),
        route({ serviceDate: "2026-11-01", vehicleId: "a", matrixSource: null }),
      ],
      trips: [],
      runs: [],
    };
    const days = computeKpisByDay("2026-11-01", "2026-11-03", data, "2026-11-04");
    expect(days.map((d) => d.matrixSources)).toEqual([[], ["haversine"], ["osrm"]]);
    expect(summarizePeriod(days).matrixSources).toEqual(["haversine", "osrm"]);
    expect(summarizePeriod(days.slice(2)).matrixSources).toEqual(["osrm"]);
    // Two days, or a period, whose km do not compare (the headline compares the focus day with the day before).
    const [none, straight, road] = days as [DayKpis, DayKpis, DayKpis];
    expect(mixedDistanceSources(straight, road)).toBe(true);
    expect(mixedDistanceSources(road, road)).toBe(false);
    expect(mixedDistanceSources(none, road)).toBe(false);
    expect(mixedDistanceSources({ matrixSources: ["mixed"] })).toBe(true);
    expect(mixedDistanceSources(summarizePeriod(days))).toBe(true);
  });
});

describe("simulated days", () => {
  it("marks a day «\u202fsimulé\u202f» when one of its runs comes from the history simulation, and counts them over the period", () => {
    const run = (serviceDate: string, simulated?: boolean): KpiRun => ({ serviceDate, startedAt: paris(serviceDate, "06:00"), simulated });
    const data: KpiData = {
      routes: [route({ serviceDate: "2026-11-02" }), route({ serviceDate: "2026-11-03" })],
      trips: [],
      runs: [run("2026-11-02", true), run("2026-11-02", true), run("2026-11-03", false), run("2026-11-01")],
    };
    const days = computeKpisByDay("2026-11-01", "2026-11-03", data, TODAY);
    expect(days.map((d) => d.simulated)).toEqual([false, true, false]);
    expect(summarizePeriod(days).simulatedDays).toBe(1);
  });
});
