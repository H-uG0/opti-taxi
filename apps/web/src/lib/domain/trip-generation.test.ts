import type { Prisma, PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fromIsoDate, toIsoDate } from "@/lib/time";
import { generateTrips, planTripsFromRecurrences, type RecurrenceForGeneration } from "./trip-generation";

// The first Date#toISOString() of a test worker can take several seconds on a slow
// Windows machine (4-7 s observed): pay it once here, outside the per-test timeout.
beforeAll(() => {
  new Date(0).toISOString();
}, 60_000);

// Week of Monday 2026-11-02 to Sunday 2026-11-08.
const MONDAY = "2026-11-02";
const SUNDAY = "2026-11-08";

const HOME = { address: "12 rue des Lilas", postalCode: "13012", city: "Marseille", lat: 43.3021, lng: 5.4213 };
const CARE = { address: "112 boulevard des Oliviers", postalCode: "13012", city: "Marseille", lat: 43.2967, lng: 5.4094 };

type RecurrenceOverrides = Omit<Partial<RecurrenceForGeneration>, "patient" | "prescription"> & {
  patient?: Partial<RecurrenceForGeneration["patient"]>;
  prescription?: Partial<RecurrenceForGeneration["prescription"]>;
};

/** Dialysis Monday / Wednesday / Friday, appointment 07:30, 4 h session, TAP sharing on both legs. */
function recurrence(overrides: RecurrenceOverrides = {}): RecurrenceForGeneration {
  const { patient, prescription, ...rest } = overrides;
  return {
    id: "rec_1",
    patientId: "pat_1",
    facilityId: "fac_1",
    prescriptionId: "pre_1",
    weekdays: [1, 3, 5],
    appointmentMinute: 450,
    sessionMinutes: 240,
    legs: "BOTH",
    startDate: fromIsoDate("2026-10-01"),
    endDate: null,
    active: true,
    facility: CARE,
    ...rest,
    patient: { ...HOME, active: true, ...patient },
    prescription: {
      mode: "TAP",
      sharing: "BOTH",
      validFrom: fromIsoDate("2026-09-01"),
      validTo: fromIsoDate("2027-03-01"),
      ...prescription,
    },
  };
}

function dayOf(trip: Prisma.TripCreateManyInput): string {
  return toIsoDate(new Date(trip.serviceDate));
}

function summary(trips: Prisma.TripCreateManyInput[]): string[] {
  return trips.map((trip) => `${dayOf(trip)} ${trip.direction}`);
}

describe("planTripsFromRecurrences — calendar", () => {
  it("creates an outbound and a return trip on each recurrence weekday", () => {
    const trips = planTripsFromRecurrences([recurrence()], MONDAY, SUNDAY);
    expect(summary(trips)).toEqual([
      "2026-11-02 OUTBOUND",
      "2026-11-02 RETURN",
      "2026-11-04 OUTBOUND",
      "2026-11-04 RETURN",
      "2026-11-06 OUTBOUND",
      "2026-11-06 RETURN",
    ]);
  });

  it("stores the service date at UTC midnight (@db.Date)", () => {
    const [first] = planTripsFromRecurrences([recurrence()], MONDAY, MONDAY);
    expect(first?.serviceDate).toEqual(fromIsoDate(MONDAY));
  });

  it("handles Saturday and Sunday weekdays (ISO 6 and 7)", () => {
    const trips = planTripsFromRecurrences([recurrence({ weekdays: [6, 7], legs: "OUTBOUND" })], MONDAY, SUNDAY);
    expect(summary(trips)).toEqual(["2026-11-07 OUTBOUND", "2026-11-08 OUTBOUND"]);
  });

  it("includes both ends of the range and crosses month ends", () => {
    const trips = planTripsFromRecurrences([recurrence({ weekdays: [1, 2, 3, 4, 5, 6, 7], legs: "OUTBOUND" })], "2026-11-29", "2026-12-02");
    expect(trips.map(dayOf)).toEqual(["2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"]);
  });

  it("returns nothing for an empty or inverted range", () => {
    expect(planTripsFromRecurrences([recurrence()], SUNDAY, MONDAY)).toEqual([]);
    expect(planTripsFromRecurrences([], MONDAY, SUNDAY)).toEqual([]);
    // Tuesday only: no Monday / Wednesday / Friday inside.
    expect(planTripsFromRecurrences([recurrence()], "2026-11-03", "2026-11-03")).toEqual([]);
  });
});

describe("planTripsFromRecurrences — legs", () => {
  it("generates only the outbound leg", () => {
    const trips = planTripsFromRecurrences([recurrence({ legs: "OUTBOUND" })], MONDAY, SUNDAY);
    expect(trips).toHaveLength(3);
    expect(trips.every((trip) => trip.direction === "OUTBOUND")).toBe(true);
  });

  it("generates only the return leg", () => {
    const trips = planTripsFromRecurrences([recurrence({ legs: "RETURN" })], MONDAY, SUNDAY);
    expect(trips).toHaveLength(3);
    expect(trips.every((trip) => trip.direction === "RETURN")).toBe(true);
  });
});

describe("planTripsFromRecurrences — validity", () => {
  it("starts on the recurrence start date (inclusive)", () => {
    const trips = planTripsFromRecurrences([recurrence({ startDate: fromIsoDate("2026-11-04") })], MONDAY, SUNDAY);
    expect([...new Set(trips.map(dayOf))]).toEqual(["2026-11-04", "2026-11-06"]);
  });

  it("stops after the recurrence end date (inclusive)", () => {
    const trips = planTripsFromRecurrences([recurrence({ endDate: fromIsoDate("2026-11-04") })], MONDAY, SUNDAY);
    expect([...new Set(trips.map(dayOf))]).toEqual(["2026-11-02", "2026-11-04"]);
  });

  it("produces nothing for a recurrence that starts after or ends before the range", () => {
    expect(planTripsFromRecurrences([recurrence({ startDate: fromIsoDate("2026-11-09") })], MONDAY, SUNDAY)).toEqual([]);
    expect(planTripsFromRecurrences([recurrence({ endDate: fromIsoDate("2026-11-01") })], MONDAY, SUNDAY)).toEqual([]);
  });

  it("needs a prescription valid on the trip date (both bounds inclusive)", () => {
    const fromWednesday = recurrence({ prescription: { validFrom: fromIsoDate("2026-11-04") } });
    expect([...new Set(planTripsFromRecurrences([fromWednesday], MONDAY, SUNDAY).map(dayOf))]).toEqual([
      "2026-11-04",
      "2026-11-06",
    ]);
    const untilWednesday = recurrence({ prescription: { validTo: fromIsoDate("2026-11-04") } });
    expect([...new Set(planTripsFromRecurrences([untilWednesday], MONDAY, SUNDAY).map(dayOf))]).toEqual([
      "2026-11-02",
      "2026-11-04",
    ]);
    const expired = recurrence({ prescription: { validTo: fromIsoDate("2026-10-31") } });
    expect(planTripsFromRecurrences([expired], MONDAY, SUNDAY)).toEqual([]);
  });

  it("skips inactive recurrences and inactive patients", () => {
    expect(planTripsFromRecurrences([recurrence({ active: false })], MONDAY, SUNDAY)).toEqual([]);
    expect(planTripsFromRecurrences([recurrence({ patient: { active: false } })], MONDAY, SUNDAY)).toEqual([]);
  });

  it("keeps the other recurrences when one is skipped", () => {
    const trips = planTripsFromRecurrences(
      [recurrence({ id: "rec_off", active: false }), recurrence({ id: "rec_on", weekdays: [2] })],
      MONDAY,
      SUNDAY,
    );
    expect(trips.map((trip) => trip.recurrenceId)).toEqual(["rec_on", "rec_on"]);
  });
});

describe("planTripsFromRecurrences — trip content", () => {
  const [outbound, ret] = planTripsFromRecurrences([recurrence()], MONDAY, MONDAY);

  it("links the trip to its patient, prescription, recurrence and facility, paid by the CPAM", () => {
    for (const trip of [outbound, ret]) {
      expect(trip).toMatchObject({
        patientId: "pat_1",
        prescriptionId: "pre_1",
        recurrenceId: "rec_1",
        facilityId: "fac_1",
        payer: "CPAM",
        allowedVehicleTypes: ["TAXI", "VSL"],
      });
    }
  });

  it("gives the outbound trip the appointment time and no ready time", () => {
    expect(outbound?.appointmentMinute).toBe(450);
    expect(outbound?.readyMinute ?? null).toBeNull();
  });

  it("gives the return trip ready time = appointment + session, and no appointment", () => {
    expect(ret?.readyMinute).toBe(450 + 240);
    expect(ret?.appointmentMinute ?? null).toBeNull();
    const [, shortReturn] = planTripsFromRecurrences(
      [recurrence({ appointmentMinute: 600, sessionMinutes: 25 })],
      MONDAY,
      MONDAY,
    );
    expect(shortReturn?.readyMinute).toBe(625);
  });

  it("goes from home to the facility, then back, with an address snapshot and coordinates", () => {
    expect(outbound).toMatchObject({
      pickupAddress: "12 rue des Lilas, 13012 Marseille",
      pickupLat: HOME.lat,
      pickupLng: HOME.lng,
      dropoffAddress: "112 boulevard des Oliviers, 13012 Marseille",
      dropoffLat: CARE.lat,
      dropoffLng: CARE.lng,
    });
    expect(ret).toMatchObject({
      pickupAddress: "112 boulevard des Oliviers, 13012 Marseille",
      pickupLat: CARE.lat,
      pickupLng: CARE.lng,
      dropoffAddress: "12 rue des Lilas, 13012 Marseille",
      dropoffLat: HOME.lat,
      dropoffLng: HOME.lng,
    });
  });
});

describe("planTripsFromRecurrences — sharing flags per leg", () => {
  function legsFor(prescription: Partial<RecurrenceForGeneration["prescription"]>) {
    const [outbound, ret] = planTripsFromRecurrences([recurrence({ prescription })], MONDAY, MONDAY);
    return {
      outbound: { allowed: outbound?.sharingAllowed, status: outbound?.sharingStatus },
      ret: { allowed: ret?.sharingAllowed, status: ret?.sharingStatus },
    };
  }

  it("allows sharing on both legs with scope BOTH", () => {
    expect(legsFor({ sharing: "BOTH" })).toEqual({
      outbound: { allowed: true, status: "NOT_PROPOSED" },
      ret: { allowed: true, status: "NOT_PROPOSED" },
    });
  });

  it("allows sharing on the outbound leg only with scope OUTBOUND", () => {
    expect(legsFor({ sharing: "OUTBOUND" })).toEqual({
      outbound: { allowed: true, status: "NOT_PROPOSED" },
      ret: { allowed: false, status: "NOT_ELIGIBLE" },
    });
  });

  it("allows sharing on the return leg only with scope RETURN", () => {
    expect(legsFor({ sharing: "RETURN" })).toEqual({
      outbound: { allowed: false, status: "NOT_ELIGIBLE" },
      ret: { allowed: true, status: "NOT_PROPOSED" },
    });
  });

  it("never shares with scope NONE", () => {
    expect(legsFor({ sharing: "NONE" })).toEqual({
      outbound: { allowed: false, status: "NOT_ELIGIBLE" },
      ret: { allowed: false, status: "NOT_ELIGIBLE" },
    });
  });

  it("sends an ambulance prescription by ambulance, never shared", () => {
    const [outbound, ret] = planTripsFromRecurrences(
      [recurrence({ prescription: { mode: "AMBULANCE", sharing: "BOTH" } })],
      MONDAY,
      MONDAY,
    );
    for (const trip of [outbound, ret]) {
      expect(trip?.allowedVehicleTypes).toEqual(["AMBULANCE"]);
      expect(trip?.sharingAllowed).toBe(false);
      expect(trip?.sharingStatus).toBe("NOT_ELIGIBLE");
    }
  });
});

describe("planTripsFromRecurrences — several recurrences", () => {
  it("yields at most one trip per (recurrence, date, direction)", () => {
    const trips = planTripsFromRecurrences(
      [
        recurrence({ id: "rec_dialysis" }),
        recurrence({ id: "rec_radio", patientId: "pat_2", weekdays: [1, 2, 3, 4, 5], appointmentMinute: 540, sessionMinutes: 20 }),
      ],
      MONDAY,
      SUNDAY,
    );
    expect(trips).toHaveLength(3 * 2 + 5 * 2);
    const keys = trips.map((trip) => `${trip.recurrenceId}|${dayOf(trip)}|${trip.direction}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("generateTrips", () => {
  function fakePrisma(recurrences: RecurrenceForGeneration[], created: number) {
    const findMany = vi.fn().mockResolvedValue(recurrences);
    const createMany = vi.fn().mockResolvedValue({ count: created });
    const prisma = { recurrence: { findMany }, trip: { createMany } } as unknown as PrismaClient;
    return { prisma, findMany, createMany };
  }

  it("loads the recurrences overlapping the range with their patient, facility and prescription", async () => {
    const { prisma, findMany } = fakePrisma([], 0);
    await generateTrips(prisma, MONDAY, SUNDAY);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        active: true,
        startDate: { lte: fromIsoDate(SUNDAY) },
        OR: [{ endDate: null }, { endDate: { gte: fromIsoDate(MONDAY) } }],
      },
      include: { patient: true, facility: true, prescription: true },
    });
  });

  it("inserts the planned trips, skipping those that already exist", async () => {
    const { prisma, createMany } = fakePrisma([recurrence()], 4);
    const result = await generateTrips(prisma, MONDAY, SUNDAY);
    expect(result).toEqual({ planned: 6, created: 4 });
    expect(createMany).toHaveBeenCalledTimes(1);
    const args = createMany.mock.calls[0]?.[0] as { data: Prisma.TripCreateManyInput[]; skipDuplicates: boolean };
    expect(args.skipDuplicates).toBe(true);
    expect(summary(args.data)).toEqual(summary(planTripsFromRecurrences([recurrence()], MONDAY, SUNDAY)));
  });
});
