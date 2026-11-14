import { describe, expect, it } from "vitest";
import type { VehicleType } from "@prisma/client";
import type { KpiTrip } from "./kpis-rows";
import {
  addSharing,
  eligibleSharedRate,
  emptySharing,
  measuredSharedRate,
  notSharedReason,
  sharingOfDay,
  tapSharedRate,
  yearToDateMonths,
} from "./kpis-sharing";

// November 2026: Europe/Paris is UTC+1.
const DAY = "2026-11-03";
const at = (hhmm: string, date = DAY) => new Date(`${date}T${hhmm}:00+01:00`);

let next = 0;
function trip(overrides: Partial<KpiTrip> = {}): KpiTrip {
  next += 1;
  return {
    id: `t${next}`,
    patientId: `p${next}`,
    serviceDate: DAY,
    status: "ASSIGNED",
    routeId: "taxi",
    direction: "OUTBOUND",
    shared: false,
    appointmentMinute: 480,
    plannedDropoffMinute: 470,
    dropoffCompletedAt: null,
    payer: "CPAM",
    sharingAllowed: true,
    sharingStatus: "NOT_PROPOSED",
    allowedVehicleTypes: ["TAXI", "VSL"],
    ...overrides,
  };
}

const TYPES: Record<string, VehicleType> = { taxi: "TAXI", taxi2: "TAXI", vsl: "VSL", amb: "AMBULANCE" };
const typeOf = (routeId: string) => TYPES[routeId];

describe("shared transport as the Assurance maladie counts it (KPI-04)", () => {
  it("counts eligible trips in a taxi or a VSL, apart, and keeps the all-TAP rate beside it", () => {
    const s = sharingOfDay(
      [
        trip({ shared: true }),
        trip(),
        trip({ routeId: "vsl", shared: true }),
        trip({ routeId: "vsl", sharingAllowed: false }),
        // Out of scope: an ambulance (lying or exceptional), a private client, a trip not served.
        trip({ routeId: "amb", allowedVehicleTypes: ["AMBULANCE"] }),
        trip({ routeId: "amb", exceptionalAmbulance: true }),
        trip({ payer: "PRIVATE", shared: true }),
        trip({ status: "NO_SHOW", shared: true }),
        trip({ status: "PLANNED", routeId: null }),
      ],
      typeOf,
    );
    expect(s.eligible).toEqual({ TAXI: 2, VSL: 1 });
    expect(s.eligibleShared).toEqual({ TAXI: 1, VSL: 1 });
    expect(eligibleSharedRate(s, "TAXI")).toBe(0.5);
    expect(eligibleSharedRate(s, "VSL")).toBe(1);
    expect(eligibleSharedRate(s)).toBeCloseTo(2 / 3);
    expect(s.tap).toEqual({ TAXI: 2, VSL: 2 });
    expect(tapSharedRate(s)).toBe(0.5);
  });

  it("measures sharing from the crews' timestamps: two patients of the route on board at the same time", () => {
    const done = (routeId: string, from: string, to: string, overrides: Partial<KpiTrip> = {}) =>
      trip({ routeId, status: "DROPPED_OFF", shared: true, pickupCompletedAt: at(from), dropoffCompletedAt: at(to), ...overrides });
    const s = sharingOfDay(
      [
        // Picked up 7:00 and 7:10, dropped 7:40 and 7:42: together.
        done("taxi", "07:00", "07:40"),
        done("taxi", "07:10", "07:42"),
        // Planned shared, but the co-passenger was absent: alone.
        done("taxi2", "08:00", "08:30"),
        trip({ routeId: "taxi2", status: "NO_SHOW", shared: true }),
        // One after the other on the same route: never together (the boundary does not count).
        done("vsl", "09:00", "09:30", { shared: false }),
        done("vsl", "09:30", "10:00", { shared: false }),
        // Dropped off without the pickup time: not measured.
        trip({ routeId: "vsl", status: "DROPPED_OFF", dropoffCompletedAt: at("11:00") }),
      ],
      typeOf,
    );
    expect(s.measured).toEqual({ TAXI: 3, VSL: 2 });
    expect(s.measuredShared).toEqual({ TAXI: 2, VSL: 0 });
    expect(measuredSharedRate(s, "TAXI")).toBeCloseTo(2 / 3);
    expect(s.eligibleShared.TAXI).toBe(3);
  });

  it("follows the funnel of the decree: eligible, proposed, accepted, refused, the patients who refuse and the delays", () => {
    const s = sharingOfDay(
      [
        trip({ sharingStatus: "PROPOSED", sharingProposedAt: at("16:30", "2026-11-02") }),
        trip({ sharingStatus: "ACCEPTED", sharingProposedAt: at("16:30", "2026-11-02"), sharingRespondedAt: at("16:50", "2026-11-02") }),
        trip({
          patientId: "refuser",
          sharingStatus: "REFUSED",
          sharingProposedAt: at("16:30", "2026-11-02"),
          sharingRespondedAt: at("17:30", "2026-11-02"),
        }),
        // A refusal known in advance: recorded with its proposal, not a delay.
        trip({ patientId: "refuser", sharingStatus: "REFUSED", sharingProposedAt: at("16:00", "2026-11-02"), sharingRespondedAt: at("16:00", "2026-11-02") }),
        trip(),
        // Not eligible: no sharing on the prescription, a lying patient, a private client, cancelled the day before.
        trip({ sharingAllowed: false, sharingStatus: "NOT_ELIGIBLE" }),
        trip({ allowedVehicleTypes: ["AMBULANCE"], routeId: "amb" }),
        trip({ payer: "PRIVATE" }),
        trip({ status: "CANCELLED", routeId: null, cancellationReason: "PATIENT", cancelledAt: at("10:00", "2026-11-02"), sharingStatus: "ACCEPTED" }),
        // Cancelled on the day: still in the funnel (it was proposed and answered).
        trip({ status: "CANCELLED", routeId: null, cancellationReason: "PATIENT", cancelledAt: at("06:00"), sharingStatus: "ACCEPTED" }),
      ],
      typeOf,
    );
    expect(s.funnel).toEqual({ eligible: 6, proposed: 5, accepted: 2, refused: 2 });
    expect(s.refusingPatientIds).toEqual(["refuser"]);
    expect(s.responseDelays).toEqual([20, 60]);
  });

  it("says why a served seated trip was not shared, and the detours of those that were", () => {
    expect(notSharedReason({ payer: "PRIVATE", sharingAllowed: true })).toBe("private");
    expect(notSharedReason({ payer: "CPAM", sharingAllowed: false })).toBe("prescription");
    expect(notSharedReason({ payer: "CPAM", sharingAllowed: true, sharingStatus: "REFUSED" })).toBe("refused");
    expect(notSharedReason({ payer: "CPAM", sharingAllowed: true, sharingStatus: "ACCEPTED" })).toBe("noMatch");
    const s = sharingOfDay(
      [
        trip({ shared: true, detourKm: 2 }),
        trip({ shared: true, detourKm: 8.5 }),
        trip({ routeId: "vsl", shared: true, detourKm: null }),
        trip({ sharingStatus: "REFUSED" }),
        trip({ sharingAllowed: false }),
        trip(),
        trip({ routeId: "amb", allowedVehicleTypes: ["AMBULANCE"] }),
      ],
      typeOf,
    );
    expect(s.reasons).toEqual({ shared: 3, private: 0, prescription: 1, refused: 1, noMatch: 1 });
    expect(s.detour).toEqual({ count: 2, sumKm: 10.5, maxKm: 8.5 });
  });

  it("adds two periods: counters, the set of refusing patients, delays and the largest detour", () => {
    const a = sharingOfDay([trip({ patientId: "x", sharingStatus: "REFUSED" }), trip({ shared: true, detourKm: 3 })], typeOf);
    const b = sharingOfDay([trip({ patientId: "x", sharingStatus: "REFUSED" }), trip({ patientId: "y", sharingStatus: "REFUSED" })], typeOf);
    const sum = addSharing(a, b);
    expect(sum.funnel.refused).toBe(3);
    expect(sum.refusingPatientIds).toEqual(["x", "y"]);
    expect(sum.detour.maxKm).toBe(3);
    expect(addSharing(emptySharing(), emptySharing())).toEqual(emptySharing());
    expect(eligibleSharedRate(emptySharing())).toBeNull();
  });

  it("fills the months of the year to date and sums them", () => {
    const { months, total } = yearToDateMonths(
      [
        { month: "2026-01", type: "VSL", tap: 10, tapShared: 3, eligible: 8, eligibleShared: 3 },
        { month: "2026-03", type: "TAXI", tap: 20, tapShared: 4, eligible: 10, eligibleShared: 4 },
        { month: "2026-03", type: "VSL", tap: 5, tapShared: 1, eligible: 5, eligibleShared: 1 },
        // Ignored: another type, a month after `to`.
        { month: "2026-03", type: "AMBULANCE", tap: 9, tapShared: 0, eligible: 9, eligibleShared: 0 },
        { month: "2026-05", type: "VSL", tap: 1, tapShared: 1, eligible: 1, eligibleShared: 1 },
      ],
      "2026-04-15",
    );
    expect(months.map((m) => m.month)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    expect(months[1]?.eligible).toEqual({ VSL: 0, TAXI: 0 });
    expect(total).toMatchObject({ month: "2026", eligible: { VSL: 13, TAXI: 10 }, eligibleShared: { VSL: 4, TAXI: 4 } });
    expect(eligibleSharedRate(total)).toBeCloseTo(8 / 23);
  });
});
