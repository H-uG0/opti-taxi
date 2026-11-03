import { describe, expect, it } from "vitest";
import {
  buildOptimizeRequest,
  CONTRACT_MAX_TIME_LIMIT_SEC,
  effectiveTimeLimitSec,
  isStaleRun,
  resolveVehicleAvailability,
  STALE_RUN_MARGIN_SEC,
  toContractSettings,
  type DriverInput,
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
    depotLat: 43.2965,
    depotLng: 5.3698,
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

let nextTariffId = 1;

function tariff(overrides: Partial<TariffInput> = {}): TariffInput {
  return {
    id: `tariff_${nextTariffId++}`,
    createdAt: new Date("2025-12-01T00:00:00Z"),
    vehicleType: "TAXI",
    department: "13",
    baseFare: 13,
    pricePerKm: 1.12,
    includedKm: 0,
    sharedDiscount2: 0.23,
    sharedDiscount3: 0.35,
    validFrom: new Date("2026-01-01T00:00:00Z"),
    validTo: null,
    ...overrides,
  };
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
    });
  });
});

describe("solver budget", () => {
  it("keeps the configured limit for a small day and gives 1 s per 8 trips to a large one", () => {
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
      ["b", expect.stringMatching(/^Chauffeur inactif/)],
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

  it("drops the break when breakMinutes is 0 or there is no window", () => {
    const { available } = resolveVehicleAvailability(
      [
        vehicle("v1", { defaultDriver: driver("d1", { breakMinutes: 0 }) }),
        vehicle("v2", { defaultDriver: driver("d2", { breakWindowStartMinute: null, breakWindowEndMinute: null }) }),
      ],
      TUESDAY,
    );
    expect(available.map((v) => v.break)).toEqual([null, null]);
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
  it("sends the grids in force on the date, the most recent one per type and department", () => {
    const { request } = buildOptimizeRequest(
      input({
        tariffs: [
          tariff({ baseFare: 10, validFrom: new Date("2025-01-01T00:00:00Z"), validTo: new Date("2025-12-31T00:00:00Z") }),
          tariff({ baseFare: 12, validFrom: new Date("2026-01-01T00:00:00Z") }),
          tariff({ baseFare: 13, validFrom: new Date("2026-06-01T00:00:00Z") }),
          tariff({ baseFare: 14, validFrom: new Date("2026-12-01T00:00:00Z") }),
          tariff({ vehicleType: "VSL", department: "*", baseFare: 9, validTo: new Date("2026-11-03T00:00:00Z") }),
        ],
      }),
    );
    expect(request.tariffs).toEqual([
      { vehicleType: "TAXI", department: "13", baseFare: 13, pricePerKm: 1.12, includedKm: 0, sharedDiscount2: 0.23, sharedDiscount3: 0.35 },
      { vehicleType: "VSL", department: "*", baseFare: 9, pricePerKm: 1.12, includedKm: 0, sharedDiscount2: 0.23, sharedDiscount3: 0.35 },
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
