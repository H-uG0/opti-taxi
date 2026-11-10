import { describe, expect, it } from "vitest";
import { tariffRow } from "@/test/tariff-fixtures";
import {
  applyDayCrewPlan,
  buildOptimizeRequest,
  CONTRACT_MAX_TIME_LIMIT_SEC,
  effectiveTimeLimitSec,
  isStaleRun,
  resolveVehicleAvailability,
  STALE_RUN_MARGIN_SEC,
  toContractSettings,
  tripServiceMinutes,
  NO_BILLING,
  type BillingInput,
  type DriverInput,
  type ServiceSettings,
  type OptimizeInput,
  type SettingsInput,
  type TariffInput,
  type TripInput,
  type VehicleInput,
} from "./build-request";
import { optimizeRequestSchema } from "./contract";

// 2026-11-03 is a Tuesday (ISO weekday 2).
const TUESDAY = "2026-11-03";

const settings: SettingsInput = {
  waitBeforeAppointmentMin: 30,
  waitAfterSessionMin: 15,
  maxTotalWaitMin: 45,
  maxDetourKmPerExtraPatient: 10,
  maxDetourKmTotal: 30,
  pickupServiceMin: 5,
  dropoffServiceMin: 5,
  unassignedPenalty: 10000,
  solverTimeLimitSec: 12,
};

function driver(id: string, overrides: Partial<DriverInput> = {}): DriverInput {
  return {
    id,
    firstName: "Prénom",
    lastName: id.toUpperCase(),
    active: true,
    workDays: [1, 2, 3, 4, 5],
    shiftStartMinute: 360,
    shiftEndMinute: 1140,
    breakWindowStartMinute: 690,
    breakWindowEndMinute: 840,
    breakMinutes: 45,
    hourlyCost: 24,
    ...overrides,
  };
}

function vehicle(id: string, overrides: Partial<VehicleInput> = {}): VehicleInput {
  return {
    id,
    label: `Véhicule ${id}`,
    type: "TAXI",
    capacity: 2,
    depot: { lat: 43.2965, lng: 5.3698 },
    department: "13",
    costPerKm: 0.32,
    active: true,
    defaultDriver: driver(`drv_${id}`),
    defaultCrewMate: null,
    ...overrides,
  };
}

function trip(id: string, overrides: Partial<TripInput> = {}): TripInput {
  return {
    id,
    patientId: `pat_${id}`,
    recurrenceId: null,
    facilityId: "fac_1",
    direction: "OUTBOUND",
    status: "PLANNED",
    pickupLat: 43.31,
    pickupLng: 5.39,
    dropoffLat: 43.526,
    dropoffLng: 5.438,
    appointmentMinute: 450,
    readyMinute: null,
    allowedVehicleTypes: ["TAXI", "VSL"],
    sharingAllowed: true,
    sharingStatus: "NOT_PROPOSED",
    lockedVehicleId: null,
    ...overrides,
  };
}

function tariff(overrides: Partial<TariffInput> = {}): TariffInput {
  return tariffRow(overrides);
}

function input(overrides: Partial<OptimizeInput> = {}): OptimizeInput {
  return { date: TUESDAY, settings, vehicles: [vehicle("v1")], trips: [trip("t1")], tariffs: [tariff()], ...overrides };
}

describe("settings mapping", () => {
  it("maps AppSettings to the contract, solverTimeLimitSec -> timeLimitSec", () => {
    expect(toContractSettings(settings, 20)).toEqual({
      waitBeforeAppointmentMin: 30,
      waitAfterSessionMin: 15,
      maxTotalWaitMin: 45,
      maxDetourKmPerExtraPatient: 10,
      maxDetourKmTotal: 30,
      pickupServiceMin: 5,
      dropoffServiceMin: 5,
      unassignedPenalty: 10000,
      timeLimitSec: 12,
      maxRideExtraMin: 30,
    });
    expect(toContractSettings({ ...settings, maxRideExtraMin: 20 }, 20).maxRideExtraMin).toBe(20);
  });
});

describe("stop durations per trip", () => {
  const service: ServiceSettings = {
    pickupServiceMin: 5,
    dropoffServiceMin: 4,
    ambulancePickupServiceMin: 15,
    ambulanceDropoffServiceMin: null,
    wheelchairExtraServiceMin: 5,
    lyingExtraServiceMin: 10,
  };
  const seated = { direction: "OUTBOUND", allowedVehicleTypes: ["TAXI", "VSL"] } as const;

  it("leaves both out when they are the settings' own (request unchanged without these settings)", () => {
    expect(tripServiceMinutes(seated, service)).toEqual({ pickupServiceMin: null, dropoffServiceMin: null });
    expect(tripServiceMinutes({ ...seated, mobility: "SEATED", facilityExtraServiceMin: 0 }, { pickupServiceMin: 5, dropoffServiceMin: 4 })).toEqual({
      pickupServiceMin: null,
      dropoffServiceMin: null,
    });
  });

  it("takes the ambulance base for an ambulance-only trip, the taxi and VSL one otherwise", () => {
    const ambulance = { direction: "OUTBOUND", allowedVehicleTypes: ["AMBULANCE"] } as const;
    // No ambulance dropoff set: as taxi and VSL.
    expect(tripServiceMinutes(ambulance, service)).toEqual({ pickupServiceMin: 15, dropoffServiceMin: null });
    // Allowed both ways: the longer one, whatever vehicle the optimizer picks.
    expect(tripServiceMinutes({ ...ambulance, allowedVehicleTypes: ["AMBULANCE", "VSL"] }, service).pickupServiceMin).toBe(15);
  });

  it("adds the mobility to both stops and the facility to the stop at the facility", () => {
    expect(tripServiceMinutes({ ...seated, mobility: "WHEELCHAIR", facilityExtraServiceMin: 3 }, service)).toEqual({
      pickupServiceMin: 10,
      dropoffServiceMin: 12,
    });
    expect(tripServiceMinutes({ ...seated, direction: "RETURN", mobility: "LYING", facilityExtraServiceMin: 3 }, service)).toEqual({
      pickupServiceMin: 18,
      dropoffServiceMin: 14,
    });
  });

  it("sends them per trip, within the zod contract", () => {
    const build = buildOptimizeRequest({
      date: TUESDAY,
      settings: { ...settings, ...service },
      vehicles: [vehicle("v")],
      trips: [trip("plain"), trip("chair", { mobility: "WHEELCHAIR" })],
      tariffs: [],
    });
    const [plain, chair] = build.request.trips;
    expect(plain).not.toHaveProperty("pickupServiceMin");
    expect(chair).toMatchObject({ pickupServiceMin: 10, dropoffServiceMin: 9 });
    expect(optimizeRequestSchema.safeParse(build.request).success).toBe(true);
  });
});

describe("solver budget", () => {
  it("keeps the configured limit for a small day and gives 1\u00a0s per 8 trips to a large one", () => {
    expect(effectiveTimeLimitSec(10, 0)).toBe(10);
    expect(effectiveTimeLimitSec(10, 80)).toBe(10);
    expect(effectiveTimeLimitSec(10, 81)).toBe(11);
    expect(effectiveTimeLimitSec(10, 200)).toBe(25);
    expect(effectiveTimeLimitSec(60, 200)).toBe(60);
  });

  it("never exceeds the contract maximum", () => {
    expect(effectiveTimeLimitSec(10, 10_000)).toBe(CONTRACT_MAX_TIME_LIMIT_SEC);
    expect(effectiveTimeLimitSec(CONTRACT_MAX_TIME_LIMIT_SEC, 0)).toBe(CONTRACT_MAX_TIME_LIMIT_SEC);
  });

  it("sends the scaled budget in the request, within the zod contract", () => {
    const trips = Array.from({ length: 120 }, (_, i) => trip(`t${i}`));
    const { request } = buildOptimizeRequest(input({ trips }));
    expect(request.settings.timeLimitSec).toBe(15);
    expect(optimizeRequestSchema.parse(request).settings.timeLimitSec).toBe(15);
  });

  it("counts only the trips actually sent", () => {
    const trips = [
      ...Array.from({ length: 100 }, (_, i) => trip(`t${i}`)),
      ...Array.from({ length: 40 }, (_, i) => trip(`x${i}`, { status: "CANCELLED" })),
    ];
    expect(buildOptimizeRequest(input({ trips })).request.settings.timeLimitSec).toBe(13);
  });

  it("declares a RUNNING run interrupted only after its own scaled budget plus the margin", () => {
    const now = new Date("2026-11-02T18:00:00Z");
    const startedSecAgo = (sec: number) => new Date(now.getTime() - sec * 1000);
    // Small run: 12 s budget.
    expect(isStaleRun({ startedAt: startedSecAgo(12 + STALE_RUN_MARGIN_SEC - 1), tripsCount: 10 }, 12, now)).toBe(false);
    expect(isStaleRun({ startedAt: startedSecAgo(12 + STALE_RUN_MARGIN_SEC + 1), tripsCount: 10 }, 12, now)).toBe(true);
    // 800 trips: 100 s budget, still alive where a 12 s budget would call it stale.
    expect(isStaleRun({ startedAt: startedSecAgo(12 + STALE_RUN_MARGIN_SEC + 60), tripsCount: 800 }, 12, now)).toBe(false);
    expect(isStaleRun({ startedAt: startedSecAgo(100 + STALE_RUN_MARGIN_SEC + 1), tripsCount: 800 }, 12, now)).toBe(true);
  });
});

describe("vehicle availability", () => {
  it("keeps a vehicle whose driver works that weekday, with the driver's shift, break and cost", () => {
    const { available, skipped } = resolveVehicleAvailability([vehicle("v1")], TUESDAY);
    expect(skipped).toEqual([]);
    expect(available).toEqual([
      {
        id: "v1",
        label: "Véhicule v1",
        type: "TAXI",
        capacity: 2,
        depot: { lat: 43.2965, lng: 5.3698 },
        department: "13",
        costPerKm: 0.32,
        costPerHour: 24,
        shiftStartMin: 360,
        shiftEndMin: 1140,
        break: { windowStartMin: 690, windowEndMin: 840, durationMin: 45 },
      },
    ]);
  });

  it("skips a vehicle whose driver does not work that weekday", () => {
    const v = vehicle("v1", { defaultDriver: driver("d1", { workDays: [1, 3, 5] }) });
    const { available, skipped } = resolveVehicleAvailability([v], TUESDAY);
    expect(available).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(/absent le mardi/);
  });

  it("skips vehicles without driver or with an inactive driver, ignores inactive vehicles", () => {
    const { available, skipped } = resolveVehicleAvailability(
      [
        vehicle("a", { defaultDriver: null }),
        vehicle("b", { defaultDriver: driver("d", { active: false }) }),
        vehicle("c", { active: false }),
      ],
      TUESDAY,
    );
    expect(available).toEqual([]);
    expect(skipped.map((s) => [s.vehicleId, s.reason])).toEqual([
      ["a", "Aucun chauffeur attitré"],
      ["b", expect.stringMatching(/^Chauffeur désactivé/)],
    ]);
  });

  it("leaves out a vehicle whose crew of the day is blocked, with the reason", () => {
    const v = vehicle("v1", { dayCrew: { blocked: "Aucun chauffeur disponible" } });
    const { available, skipped } = resolveVehicleAvailability([v], TUESDAY);
    expect(available).toEqual([]);
    expect(skipped[0]?.reason).toBe("Aucun chauffeur disponible");
  });

  it("keeps a crew of the day on a day its driver does not usually work (weekend duty)", () => {
    const v = vehicle("v1", { defaultDriver: driver("d1", { workDays: [1, 3, 5] }), dayCrew: { blocked: null } });
    const { available, crews } = resolveVehicleAvailability([v], TUESDAY);
    expect(available.map((a) => a.id)).toEqual(["v1"]);
    expect(crews.get("v1")).toEqual({ driverId: "d1", crewMateId: null });
  });

  it("puts the crew of the day in place of the default crew", () => {
    const people = new Map([["spare", driver("spare")], ["mate", driver("mate")]]);
    const [taxi, amb, other] = applyDayCrewPlan(
      [vehicle("t"), vehicle("a", { type: "AMBULANCE" }), vehicle("x")],
      {
        crews: [
          { vehicleId: "t", driverId: "spare", crewMateId: null, blocked: null },
          { vehicleId: "a", driverId: null, crewMateId: "mate", blocked: "Aucun chauffeur disponible" },
        ],
      },
      people,
    );
    expect(taxi).toMatchObject({ defaultDriver: { id: "spare" }, dayCrew: { blocked: null } });
    expect(amb).toMatchObject({ defaultDriver: null, defaultCrewMate: { id: "mate" }, dayCrew: { blocked: "Aucun chauffeur disponible" } });
    // Unknown to the plan (an inactive vehicle): unchanged.
    expect(other).toMatchObject({ defaultDriver: { id: "drv_x" } });
    expect(other?.dayCrew).toBeUndefined();
  });

  it("gives a vehicle left out for the work-time rule its short reason", () => {
    const long = "Horaire de 12\u00a0h\u00a030 sans pause\u00a0: au-delà de 6\u00a0h de travail… Réglez la pause de Julien Marchetti";
    const short = "Pause de 20\u00a0min requise\u00a0: horaire de 12\u00a0h\u00a030 sans pause (art. L. 3121-16)";
    const [taxi] = applyDayCrewPlan(
      [vehicle("t")],
      {
        crews: [
          {
            vehicleId: "t",
            driverId: "spare",
            crewMateId: null,
            blocked: long,
            issues: [{ level: "error", seat: "driver", message: long, workTime: { summary: short } }],
          },
        ],
      },
      new Map([["spare", driver("spare")]]),
    );
    expect(taxi?.dayCrew).toEqual({ blocked: short });
  });

  it("returns the crew sent with each vehicle, for the routes saved from the plan", () => {
    const amb = vehicle("a", { type: "AMBULANCE", defaultDriver: driver("dea"), defaultCrewMate: driver("aux") });
    const build = buildOptimizeRequest({ date: TUESDAY, settings, vehicles: [amb, vehicle("t")], trips: [], tariffs: [] });
    expect([...build.crews.entries()]).toEqual([
      ["t", { driverId: "drv_t", crewMateId: null }],
      ["a", { driverId: "dea", crewMateId: "aux" }],
    ]);
  });

  it("does not let one driver work two vehicles at the same time", () => {
    const shared = driver("same");
    const { available, skipped } = resolveVehicleAvailability(
      [vehicle("v1", { label: "Taxi 1", defaultDriver: shared }), vehicle("v2", { label: "Taxi 2", defaultDriver: shared })],
      TUESDAY,
    );
    expect(available.map((v) => v.id)).toEqual(["v1"]);
    expect(skipped[0]).toMatchObject({ vehicleId: "v2", reason: "Chauffeur déjà affecté à Taxi 1 ce jour" });
  });

  it("drops the break when breakMinutes is 0 or there is no window, on a shift of 6 hours or less", () => {
    const short = { shiftStartMinute: 480, shiftEndMinute: 840 };
    const { available } = resolveVehicleAvailability(
      [
        vehicle("v1", { defaultDriver: driver("d1", { ...short, breakMinutes: 0 }) }),
        vehicle("v2", { defaultDriver: driver("d2", { ...short, breakWindowStartMinute: null, breakWindowEndMinute: null }) }),
      ],
      TUESDAY,
    );
    expect(available.map((v) => v.break)).toEqual([null, null]);
  });

  it("leaves out a vehicle whose shift is over 6 hours without a break of 20\u00a0min (art. L. 3121-16)", () => {
    const { available, skipped } = resolveVehicleAvailability(
      [
        vehicle("v1", { label: "Taxi 1", defaultDriver: driver("d1", { breakMinutes: 0 }) }),
        vehicle("v2", { label: "Taxi 2", defaultDriver: driver("d2", { breakMinutes: 15 }) }),
        vehicle("v3", { label: "Taxi 3", defaultDriver: driver("d3", { breakWindowStartMinute: 1130, breakWindowEndMinute: 1200 }) }),
        vehicle("v4", { label: "Taxi 4", defaultDriver: driver("d4", { breakMinutes: 20 }) }),
      ],
      TUESDAY,
    );
    expect(available.map((v) => v.id)).toEqual(["v4"]);
    expect(skipped.map((s) => s.reason)).toEqual([
      // In a few words: the list of vehicles left out has little room, Équipages gives the remedy.
      "Pause de 20\u00a0min requise\u00a0: horaire de 13\u00a0h\u00a000 sans pause (art. L. 3121-16)",
      expect.stringContaining("avec une pause de 15\u00a0min"),
      expect.stringContaining("fenêtre de pause qui ne laisse pas 45\u00a0min dans l'horaire"),
    ]);
  });

  it("clips the break window to the shift and ignores a break that no longer fits", () => {
    const { available, notes } = resolveVehicleAvailability(
      [
        vehicle("v1", { defaultDriver: driver("d1", { shiftStartMinute: 720, breakWindowStartMinute: 690, breakWindowEndMinute: 840 }) }),
        vehicle("v2", { defaultDriver: driver("d2", { shiftEndMinute: 700, breakWindowStartMinute: 690, breakWindowEndMinute: 840 }) }),
      ],
      TUESDAY,
    );
    expect(available[0]?.break).toEqual({ windowStartMin: 720, windowEndMin: 840, durationMin: 45 });
    expect(available[1]?.break).toBeNull();
    expect(notes).toHaveLength(1);
  });

  describe("ambulance crew", () => {
    const ambulance = (mate: DriverInput | null, overrides: Partial<VehicleInput> = {}) =>
      vehicle("amb", {
        type: "AMBULANCE",
        capacity: 2,
        defaultDriver: driver("dea", { shiftStartMinute: 420, shiftEndMinute: 1140, hourlyCost: 25 }),
        defaultCrewMate: mate,
        ...overrides,
      });

    it("requires a crew mate", () => {
      const { available, skipped } = resolveVehicleAvailability([ambulance(null)], TUESDAY);
      expect(available).toEqual([]);
      expect(skipped[0]?.reason).toMatch(/sans équipier/);
    });

    it("requires the crew mate to work that day", () => {
      const { skipped } = resolveVehicleAvailability([ambulance(driver("aux", { workDays: [1] }))], TUESDAY);
      expect(skipped[0]?.reason).toMatch(/Équipier absent le mardi/);
    });

    it("intersects shifts, adds hourly costs and carries one patient", () => {
      const mate = driver("aux", { shiftStartMinute: 360, shiftEndMinute: 1080, hourlyCost: 21 });
      const { available } = resolveVehicleAvailability([ambulance(mate)], TUESDAY);
      expect(available[0]).toMatchObject({
        type: "AMBULANCE",
        capacity: 1,
        shiftStartMin: 420,
        shiftEndMin: 1080,
        costPerHour: 46,
      });
    });

    it("rejects crews whose shifts do not overlap", () => {
      const mate = driver("aux", { shiftStartMinute: 1140, shiftEndMinute: 1300 });
      const { skipped } = resolveVehicleAvailability([ambulance(mate)], TUESDAY);
      expect(skipped[0]?.reason).toMatch(/sans recouvrement/);
    });

    it("ignores the crew mate of a taxi", () => {
      const { available } = resolveVehicleAvailability(
        [vehicle("v1", { defaultCrewMate: driver("aux", { workDays: [] }) })],
        TUESDAY,
      );
      expect(available).toHaveLength(1);
      expect(available[0]?.costPerHour).toBe(24);
    });
  });
});

describe("trips", () => {
  it("sends shareable = sharingAllowed and not refused / not eligible", () => {
    const { request } = buildOptimizeRequest(
      input({
        trips: [
          trip("ok"),
          trip("accepted", { sharingStatus: "ACCEPTED" }),
          trip("refused", { sharingStatus: "REFUSED" }),
          trip("ineligible", { sharingAllowed: false, sharingStatus: "NOT_ELIGIBLE" }),
          trip("notAllowed", { sharingAllowed: false }),
        ],
      }),
    );
    expect(Object.fromEntries(request.trips.map((t) => [t.id, t.shareable]))).toEqual({
      ok: true,
      accepted: true,
      refused: false,
      ineligible: false,
      notAllowed: false,
    });
  });

  it("leaves out cancelled and no-show trips, excludes incomplete ones with a reason", () => {
    const result = buildOptimizeRequest(
      input({
        trips: [
          trip("cancelled", { status: "CANCELLED" }),
          trip("noShow", { status: "NO_SHOW" }),
          trip("noAppointment", { appointmentMinute: null }),
          trip("noReady", { direction: "RETURN", appointmentMinute: null, readyMinute: null }),
          trip("noType", { allowedVehicleTypes: [] }),
          trip("fine"),
        ],
      }),
    );
    expect(result.request.trips.map((t) => t.id)).toEqual(["fine"]);
    expect(result.excludedTrips.map((e) => e.tripId)).toEqual(["noAppointment", "noReady", "noType"]);
  });

  it("sends only the time of its direction", () => {
    const { request } = buildOptimizeRequest(
      input({ trips: [trip("ret", { direction: "RETURN", appointmentMinute: 450, readyMinute: 690 })] }),
    );
    expect(request.trips[0]).toMatchObject({ direction: "RETURN", appointmentMin: null, readyMin: 690 });
  });

  it("keeps a lock on an available vehicle of an allowed type", () => {
    const { request, droppedLocks } = buildOptimizeRequest(input({ trips: [trip("t1", { lockedVehicleId: "v1" })] }));
    expect(request.trips[0]?.lockedVehicleId).toBe("v1");
    expect(droppedLocks).toEqual([]);
  });

  it("drops a lock on a vehicle unavailable that day and reports it", () => {
    const off = vehicle("v2", { label: "VSL Gap", defaultDriver: driver("d2", { workDays: [6] }) });
    const { request, droppedLocks } = buildOptimizeRequest(
      input({ vehicles: [vehicle("v1"), off], trips: [trip("t1", { lockedVehicleId: "v2" })] }),
    );
    expect(request.trips[0]?.lockedVehicleId).toBeNull();
    expect(droppedLocks).toEqual([
      { tripId: "t1", vehicleId: "v2", vehicleLabel: "VSL Gap", reason: expect.stringMatching(/^Véhicule indisponible ce jour/) },
    ]);
  });

  it("drops a lock on a vehicle type the prescription forbids, or on an unknown vehicle", () => {
    const amb = vehicle("amb", {
      type: "AMBULANCE",
      defaultDriver: driver("dea"),
      defaultCrewMate: driver("aux"),
    });
    const { droppedLocks } = buildOptimizeRequest(
      input({
        vehicles: [vehicle("v1"), amb],
        trips: [trip("t1", { lockedVehicleId: "amb" }), trip("t2", { lockedVehicleId: "gone" })],
      }),
    );
    expect(droppedLocks.map((d) => [d.tripId, d.reason])).toEqual([
      ["t1", "Type de véhicule non autorisé pour cette course"],
      ["t2", "Véhicule introuvable"],
    ]);
  });
});

describe("tariffs", () => {
  it("sends the grid of each vehicle, in force on the date, the most recent one per type and department", () => {
    const taxi13 = tariff({ baseFare: 13, validFrom: new Date("2026-06-01T00:00:00Z") });
    const vslAll = tariff({ vehicleType: "VSL", department: "*", baseFare: 9, validTo: new Date("2026-11-03T00:00:00Z") });
    const { request } = buildOptimizeRequest(
      input({
        vehicles: [vehicle("v1"), vehicle("vsl", { type: "VSL", department: "04" })],
        tariffs: [
          tariff({ baseFare: 10, validFrom: new Date("2025-01-01T00:00:00Z"), validTo: new Date("2025-12-31T00:00:00Z") }),
          tariff({ baseFare: 12, validFrom: new Date("2026-01-01T00:00:00Z") }),
          taxi13,
          tariff({ baseFare: 14, validFrom: new Date("2026-12-01T00:00:00Z") }),
          vslAll,
          // In force but no vehicle uses it: not sent.
          tariff({ vehicleType: "AMBULANCE", department: "*", baseFare: 57.39 }),
        ],
      }),
    );
    expect(request.vehicles.map((v) => v.tariffId)).toEqual([taxi13.id, vslAll.id]);
    expect(request.tariffs).toEqual([
      {
        id: taxi13.id,
        vehicleType: "TAXI",
        baseFare: 13,
        aggloFare: null,
        bigCityFare: 0,
        includedKm: 0,
        pricePerKm: 1.12,
        shortTripBands: [],
        nightRate: 0,
        weekendRate: 0,
        nightStartMin: 1200,
        nightEndMin: 480,
        saturdayFromMin: 720,
        surchargeShortTrip: true,
        emptyLegRateShort: 0,
        emptyLegRateLong: 0,
        emptyLegThresholdKm: 50,
        sharedDiscounts: [
          { patients: 2, rate: 0.23 },
          { patients: 3, rate: 0.35 },
        ],
        maxSharedPatients: 3,
        aloneDiscount: 0,
        aloneThresholdKm: 30,
        billableDetourKm: [],
        tpmrFare: 0,
      },
      expect.objectContaining({ id: vslAll.id, vehicleType: "VSL", baseFare: 9 }),
    ]);
  });

  it("sends the last created grid when two start the same day, whatever the input order", () => {
    // The last created grid has the smaller id, so only createdAt can pick it.
    const first = tariff({ id: "tariff_z", baseFare: 12, createdAt: new Date("2026-11-02T08:00:00Z") });
    const fixed = tariff({ id: "tariff_a", baseFare: 13, createdAt: new Date("2026-11-02T08:05:00Z") });
    for (const tariffs of [[first, fixed], [fixed, first]]) {
      const { request } = buildOptimizeRequest(input({ tariffs }));
      expect(request.tariffs.map((t) => t.baseFare)).toEqual([13]);
    }
  });

  it("flags the available vehicles no grid covers on the date (their revenue would be 0\u00a0€)", () => {
    const vsl = vehicle("vsl", { type: "VSL", label: "VSL 2", department: "04" });
    const off = vehicle("off", { type: "VSL", label: "VSL 9", department: "04", defaultDriver: driver("d9", { workDays: [6] }) });
    expect(buildOptimizeRequest(input({ vehicles: [vehicle("v1"), vsl, off] })).tariffGaps).toEqual([
      { vehicleType: "VSL", department: "04", vehicles: ["VSL 2"] },
    ]);
    // A grid ending the day before the date no longer covers it; the « * » catch-all does.
    const ended = tariff({ vehicleType: "VSL", department: "04", validTo: new Date("2026-11-02T00:00:00Z") });
    expect(buildOptimizeRequest(input({ vehicles: [vsl], tariffs: [ended] })).tariffGaps).toHaveLength(1);
    const lastDay = tariff({ vehicleType: "VSL", department: "04", validTo: new Date(`${TUESDAY}T00:00:00Z`) });
    expect(buildOptimizeRequest(input({ vehicles: [vsl], tariffs: [lastDay] })).tariffGaps).toEqual([]);
    const catchAll = tariff({ vehicleType: "VSL", department: "*" });
    expect(buildOptimizeRequest(input({ vehicles: [vsl], tariffs: [catchAll] })).tariffGaps).toEqual([]);
  });

  const certified: BillingInput = {
    ...NO_BILLING,
    company: { certifications: [{ validFrom: new Date("2025-01-01T00:00:00Z"), validTo: null }], hqDepartment: "13", hqCity: "Marseille" },
  };
  const vslMajored = tariff({ vehicleType: "VSL", department: "*", certified: true, baseFare: 15.75 });
  const vslBase13 = tariff({ vehicleType: "VSL", department: "13", certified: false, baseFare: 12.11 });
  const ambulanceMajored = tariff({ vehicleType: "AMBULANCE", department: "*", certified: true, maxSharedPatients: 1 });

  it("picks the VSL and ambulance grids of the company's certification and head office", () => {
    const vsl = vehicle("vsl", { type: "VSL", department: "04" });
    const amb = vehicle("amb", { type: "AMBULANCE", department: "05", defaultDriver: driver("dea"), defaultCrewMate: driver("aux") });
    const tariffs = [vslMajored, vslBase13, ambulanceMajored];
    const { request } = buildOptimizeRequest(input({ vehicles: [vsl, amb], tariffs, billing: certified }));
    expect(request.vehicles.map((v) => [v.id, v.tariffId, v.capacity])).toEqual([
      ["vsl", vslMajored.id, 2],
      ["amb", ambulanceMajored.id, 1],
    ]);
    const notCertified = { ...certified, company: { ...certified.company, certifications: [] } };
    expect(buildOptimizeRequest(input({ vehicles: [vsl], tariffs, billing: notCertified })).request.vehicles[0]?.tariffId).toBe(vslBase13.id);
  });

  it("never sends more seats than the vehicle's grid lets share", () => {
    const taxi = vehicle("taxi", { capacity: 4 });
    const { request } = buildOptimizeRequest(input({ vehicles: [taxi], tariffs: [tariff({ maxSharedPatients: 3 })] }));
    expect(request.vehicles[0]?.capacity).toBe(3);
    // Without a grid, the vehicle's own seats.
    expect(buildOptimizeRequest(input({ vehicles: [taxi], tariffs: [] })).request.vehicles[0]?.capacity).toBe(4);
  });

  it("sends the billing rules and the public holidays of the date and the next two days", () => {
    const billing: BillingInput = {
      ...NO_BILLING,
      rules: { emptyLegRule: "DEPOT", surchargeOrder: "ADDITIVE", sharedPatientCount: "MAX_ON_BOARD" },
      holidays: ["2026-11-01", "2026-11-04", "2026-11-11"],
    };
    expect(buildOptimizeRequest(input({ billing })).request.settings.pricing).toEqual({
      emptyLeg: "DEPOT",
      emptyLegOrder: "ADDITIVE",
      patientCount: "MAX_ON_BOARD",
      publicHolidays: ["2026-11-04"],
    });
  });
});

describe("billing flags of the trips", () => {
  const areas: BillingInput["areas"] = [
    { kind: "BIG_CITY", name: "Marseille", department: "13", communes: ["Marseille"], rule: "ANY_END", hubCommune: null, validFrom: null, validTo: null },
    {
      kind: "AGGLOMERATION",
      name: "Marseille",
      department: "13",
      communes: ["Marseille", "Allauch"],
      rule: "BOTH_INSIDE",
      hubCommune: null,
      validFrom: null,
      validTo: null,
    },
  ];
  const billing: BillingInput = { ...NO_BILLING, company: { ...NO_BILLING.company, hqCity: "Marseille" }, areas };

  it("flags «\u202fGrande ville\u202f», agglomeration, hospital-linked care, wheelchair and tolls", () => {
    const local = trip("t1", {
      pickupAddress: "3 chemin des Pins, 13190 Allauch",
      dropoffAddress: "264 rue Saint-Pierre, 13005 Marseille",
      facilityType: "DIALYSIS",
      mobility: "WHEELCHAIR",
      tollAmount: 4.2,
    });
    const far = trip("t2", { pickupAddress: "1 rue X, 04100 Manosque", dropoffAddress: "2 rue Y, 13100 Aix-en-Provence", facilityType: "HOSPITAL" });
    const { request } = buildOptimizeRequest(input({ trips: [local, far], billing }));
    expect(request.trips.map((t) => [t.bigCity, t.agglomeration, t.hospitalLinked, t.wheelchair, t.tollAmount])).toEqual([
      [true, true, true, true, 4.2],
      [false, false, false, false, 0],
    ]);
  });

  it("no agglomeration fare for a company based elsewhere", () => {
    const local = trip("t1", { pickupAddress: "3 chemin des Pins, 13190 Allauch", dropoffAddress: "264 rue Saint-Pierre, 13005 Marseille" });
    const elsewhere = { ...billing, company: { ...billing.company, hqCity: "Manosque" } };
    expect(buildOptimizeRequest(input({ trips: [local], billing: elsewhere })).request.trips[0]).toMatchObject({ bigCity: true, agglomeration: false });
  });
});

describe("exceptional ambulance for a seated trip (TAR-03)", () => {
  const amb = vehicle("amb", { type: "AMBULANCE", department: "05", defaultDriver: driver("dea"), defaultCrewMate: driver("aux") });
  const vslGrid = tariff({ vehicleType: "VSL", department: "*", baseFare: 15.75 });
  const ambGrid = tariff({ vehicleType: "AMBULANCE", department: "*", baseFare: 57.39, maxSharedPatients: 1 });
  const proposed = new Date("2026-11-02T17:00:00Z");

  it("lets the locked ambulance carry the trip at the VSL tariff", () => {
    const seated = trip("t1", { lockedVehicleId: "amb", exceptionalAmbulanceAt: proposed });
    const { request, droppedLocks } = buildOptimizeRequest(input({ vehicles: [vehicle("v1"), amb], trips: [seated], tariffs: [vslGrid, ambGrid] }));
    expect(droppedLocks).toEqual([]);
    expect(request.trips[0]).toMatchObject({ lockedVehicleId: "amb", allowedVehicleTypes: ["TAXI", "VSL", "AMBULANCE"], tariffId: vslGrid.id });
    expect(request.tariffs.map((t) => t.id)).toContain(vslGrid.id);
    expect(optimizeRequestSchema.safeParse(request).success).toBe(true);
  });

  it("is never automatic: without the lock on an ambulance, the trip stays seated", () => {
    const unlocked = trip("t1", { exceptionalAmbulanceAt: proposed });
    const onTaxi = trip("t2", { lockedVehicleId: "v1", exceptionalAmbulanceAt: proposed });
    const notProposed = trip("t3", { lockedVehicleId: "amb" });
    const { request, droppedLocks } = buildOptimizeRequest(
      input({ vehicles: [vehicle("v1"), amb], trips: [unlocked, onTaxi, notProposed], tariffs: [vslGrid, ambGrid] }),
    );
    expect(request.trips.map((t) => t.allowedVehicleTypes)).toEqual([
      ["TAXI", "VSL"],
      ["TAXI", "VSL"],
      ["TAXI", "VSL"],
    ]);
    expect(request.trips.every((t) => t.tariffId === null)).toBe(true);
    expect(droppedLocks.map((d) => d.tripId)).toEqual(["t3"]);
  });

  it("drops the ambulance with its lock when the ambulance is unavailable that day", () => {
    const off = { ...amb, defaultDriver: driver("dea", { workDays: [6] }) };
    const seated = trip("t1", { lockedVehicleId: "amb", exceptionalAmbulanceAt: proposed });
    const { request, droppedLocks } = buildOptimizeRequest(input({ vehicles: [vehicle("v1"), off], trips: [seated], tariffs: [vslGrid, ambGrid] }));
    expect(droppedLocks).toHaveLength(1);
    expect(request.trips[0]).toMatchObject({ lockedVehicleId: null, allowedVehicleTypes: ["TAXI", "VSL"], tariffId: null });
  });

  it("never applies to a trip prescribed in ambulance", () => {
    const lying = trip("t1", { allowedVehicleTypes: ["AMBULANCE"], lockedVehicleId: "amb", exceptionalAmbulanceAt: proposed });
    const { request } = buildOptimizeRequest(input({ vehicles: [amb], trips: [lying], tariffs: [vslGrid, ambGrid] }));
    expect(request.trips[0]?.tariffId).toBeNull();
  });

  it("says so when no VSL grid is in force that day: the trip would be estimated at the ambulance tariff", () => {
    const seated = trip("t1", { lockedVehicleId: "amb", exceptionalAmbulanceAt: proposed });
    const { request, notes } = buildOptimizeRequest(input({ vehicles: [vehicle("v1"), amb], trips: [seated], tariffs: [ambGrid] }));
    expect(request.trips[0]).toMatchObject({ lockedVehicleId: "amb", tariffId: null });
    expect(notes).toEqual([expect.stringMatching(/^Véhicule amb\u00a0: recours exceptionnel sans grille VSL en vigueur ce jour/)]);
    const covered = buildOptimizeRequest(input({ vehicles: [vehicle("v1"), amb], trips: [seated], tariffs: [vslGrid, ambGrid] }));
    expect(covered.notes).toEqual([]);
  });
});

describe("whole request", () => {
  it("satisfies the zod contract", () => {
    const amb = vehicle("amb", { type: "AMBULANCE", defaultDriver: driver("dea"), defaultCrewMate: driver("aux") });
    const { request } = buildOptimizeRequest(
      input({
        vehicles: [vehicle("v1"), amb],
        trips: [
          trip("t1", { lockedVehicleId: "v1" }),
          trip("t2", { direction: "RETURN", appointmentMinute: null, readyMinute: 690 }),
          trip("t3", { allowedVehicleTypes: ["AMBULANCE"], sharingAllowed: false, sharingStatus: "NOT_ELIGIBLE" }),
        ],
      }),
    );
    const parsed = optimizeRequestSchema.parse(request);
    expect(parsed.vehicles).toHaveLength(2);
    expect(parsed.trips).toHaveLength(3);
    expect(parsed.date).toBe(TUESDAY);
  });
});
