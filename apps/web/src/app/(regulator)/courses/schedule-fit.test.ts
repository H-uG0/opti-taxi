import { describe, expect, it } from "vitest";
import { sameDayPairs } from "@/lib/domain/day-pairs";
import { checkScheduleFit, type PatientDayTrip, type WaitSettings } from "./schedule-fit";

const settings: WaitSettings = { waitBeforeAppointmentMin: 30, waitAfterSessionMin: 15, maxTotalWaitMin: 45 };

function outbound(overrides: Partial<PatientDayTrip> = {}): PatientDayTrip {
  return {
    id: "out",
    direction: "OUTBOUND",
    facilityId: "fac",
    appointmentMinute: 510, // 08:30
    readyMinute: null,
    plannedPickupMinute: 470,
    plannedDropoffMinute: 500, // 08:20
    ...overrides,
  };
}

function ret(overrides: Partial<PatientDayTrip> = {}): PatientDayTrip {
  return {
    id: "ret",
    direction: "RETURN",
    facilityId: "fac",
    appointmentMinute: null,
    readyMinute: 690, // 11:30
    plannedPickupMinute: 700, // 11:40
    plannedDropoffMinute: 730,
    ...overrides,
  };
}

function reason(fit: ReturnType<typeof checkScheduleFit>): string | null {
  return fit.fits ? null : fit.reason;
}

describe("checkScheduleFit", () => {
  it("accepts a new appointment the planned dropoff still respects", () => {
    expect(checkScheduleFit("out", 520, [outbound()], settings)).toEqual({ fits: true });
    expect(checkScheduleFit("out", 500, [outbound()], settings)).toEqual({ fits: true });
  });

  it("rejects an appointment moved before the planned dropoff (late arrival)", () => {
    expect(reason(checkScheduleFit("out", 480, [outbound()], settings))).toBe(
      "dépose prévue à 08:20, après le rendez-vous de 08:00",
    );
  });

  it("rejects an appointment moved too far after the planned dropoff (wait too long)", () => {
    expect(reason(checkScheduleFit("out", 540, [outbound()], settings))).toBe(
      "dépose prévue à 08:20, soit 40\u00a0min d'attente avant le rendez-vous (30\u00a0min au plus)",
    );
  });

  it("checks the pickup window of a return leg", () => {
    expect(checkScheduleFit("ret", 695, [ret()], settings)).toEqual({ fits: true });
    expect(reason(checkScheduleFit("ret", 710, [ret()], settings))).toBe(
      "prise en charge prévue à 11:40, avant la fin de séance de 11:50",
    );
    expect(reason(checkScheduleFit("ret", 680, [ret()], settings))).toBe(
      "prise en charge prévue à 11:40, soit 20\u00a0min d'attente après la séance (15\u00a0min au plus)",
    );
  });

  it("shrinks the wait budget of a paired return like the optimizer", () => {
    const wide: WaitSettings = { waitBeforeAppointmentMin: 30, waitAfterSessionMin: 30, maxTotalWaitMin: 45 };
    // Alone, a return may wait 30 min; paired with the morning outbound, 45 - 30 = 15 min.
    expect(checkScheduleFit("ret", 675, [ret()], wide)).toEqual({ fits: true });
    expect(reason(checkScheduleFit("ret", 675, [outbound(), ret()], wide))).toBe(
      "prise en charge prévue à 11:40, soit 25\u00a0min d'attente après la séance (15\u00a0min au plus)",
    );
  });

  it("checks the same-day partner whose budget changes with the new pairing", () => {
    const wide: WaitSettings = { waitBeforeAppointmentMin: 30, waitAfterSessionMin: 30, maxTotalWaitMin: 45 };
    // The outbound appointment (12:00) is after the end of session: no pair, the return may wait 25 min.
    const trips = [outbound({ appointmentMinute: 720, plannedDropoffMinute: 700 }), ret({ readyMinute: 675 })];
    expect(checkScheduleFit("out", 715, trips, wide)).toEqual({ fits: true });
    // Moved to 08:30 (dropoff planned at 08:20): now paired, the return's budget drops to 45 - 30 = 15 min.
    const morning = [outbound({ appointmentMinute: 720, plannedDropoffMinute: 500 }), ret({ readyMinute: 675 })];
    expect(reason(checkScheduleFit("out", 510, morning, wide))).toBe(
      "retour du même jour\u00a0: prise en charge prévue à 11:40, soit 25\u00a0min d'attente après la séance (15\u00a0min au plus)",
    );
  });

  it("ignores a partner that is not planned", () => {
    const trips = [outbound(), ret({ plannedPickupMinute: null, plannedDropoffMinute: null })];
    expect(checkScheduleFit("out", 515, trips, settings)).toEqual({ fits: true });
  });

  it("does not trust a trip in a route without planned times", () => {
    expect(reason(checkScheduleFit("out", 510, [outbound({ plannedDropoffMinute: null })], settings))).toBe(
      "horaire prévu inconnu dans la tournée",
    );
    expect(checkScheduleFit("missing", 510, [outbound()], settings).fits).toBe(false);
  });
});

describe("sameDayPairs", () => {
  it("pairs a return with the latest earlier outbound, same facility first", () => {
    const o1 = outbound({ id: "o1", facilityId: "A", appointmentMinute: 480 });
    const o2 = outbound({ id: "o2", facilityId: "B", appointmentMinute: 540 });
    const r = ret({ id: "r", facilityId: "A", readyMinute: 700 });
    expect(sameDayPairs([o1, o2, r]).map((p) => [p.outbound.id, p.ret.id])).toEqual([["o1", "r"]]);
    const r2 = ret({ id: "r2", facilityId: "C", readyMinute: 700 });
    expect(sameDayPairs([o1, o2, r2]).map((p) => [p.outbound.id, p.ret.id])).toEqual([["o2", "r2"]]);
    // An outbound after the end of session is never paired.
    expect(sameDayPairs([outbound({ appointmentMinute: 720 }), ret({ readyMinute: 690 })])).toEqual([]);
  });
});
