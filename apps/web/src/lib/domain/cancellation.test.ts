import { describe, expect, it } from "vitest";
import {
  cancellationLabel,
  isLateCancellation,
  isSystemCancellation,
  minutesUntil,
  patientCancellationStats,
  patientHistoryStart,
  pickupReferenceMinute,
  systemCancellation,
  USER_CANCELLATION_REASONS,
  userCancellation,
} from "./cancellation";

// 9 November 2026, 06:00 in Paris (UTC+1 in winter).
const NOW = new Date("2026-11-09T05:00:00.000Z");

describe("minutesUntil", () => {
  it("counts the minutes from now to a time of a service day, in Paris time", () => {
    expect(minutesUntil("2026-11-09", 7 * 60, NOW)).toBe(60);
    expect(minutesUntil("2026-11-10", 6 * 60, NOW)).toBe(1440);
    expect(minutesUntil("2026-11-09", 5 * 60, NOW)).toBe(-60);
  });
});

describe("isLateCancellation", () => {
  const outbound = { serviceDate: "2026-11-09", direction: "OUTBOUND" as const, appointmentMinute: 9 * 60, readyMinute: null };

  it("measures against the planned pickup when the trip is in a route", () => {
    // Picked up at 07:30: 1 h 30 from now, under the 2 h threshold.
    expect(isLateCancellation({ ...outbound, plannedPickupMinute: 7 * 60 + 30 }, NOW, 2)).toBe(true);
    expect(isLateCancellation({ ...outbound, plannedPickupMinute: 7 * 60 + 30 }, NOW, 1)).toBe(false);
  });

  it("falls back on the appointment (outbound) or the end of session (return) outside any route", () => {
    expect(pickupReferenceMinute({ ...outbound, plannedPickupMinute: null })).toBe(540);
    expect(isLateCancellation({ ...outbound, plannedPickupMinute: null }, NOW, 2)).toBe(false);
    const back = { serviceDate: "2026-11-09", direction: "RETURN" as const, appointmentMinute: null, readyMinute: 7 * 60 + 15, plannedPickupMinute: null };
    expect(isLateCancellation(back, NOW, 2)).toBe(true);
  });

  it("is late once the pickup has passed, never for a trip without time, never with the day before", () => {
    expect(isLateCancellation({ ...outbound, plannedPickupMinute: 5 * 60 }, NOW, 0)).toBe(true);
    expect(isLateCancellation({ ...outbound, appointmentMinute: null, plannedPickupMinute: null }, NOW, 2)).toBe(false);
    expect(isLateCancellation({ ...outbound, serviceDate: "2026-11-10", plannedPickupMinute: 7 * 60 }, NOW, 2)).toBe(false);
  });
});

describe("cancellation fields", () => {
  it("records a person's cancellation with its reason, note, author, instant and lateness", () => {
    expect(userCancellation({ reason: "HOSPITALIZATION", note: "prévenu par sa fille", actorId: "u1", now: NOW, late: true })).toEqual({
      cancellationReason: "HOSPITALIZATION",
      cancellationOrigin: "USER",
      cancellationNote: "prévenu par sa fille",
      cancelledAt: NOW,
      cancelledById: "u1",
      lateCancellation: true,
    });
  });

  it("records the sync's cancellation as SYSTEM, never late, with its cause", () => {
    expect(systemCancellation("u1", NOW, "patient désactivé")).toEqual({
      cancellationReason: "REFERENTIAL_SYNC",
      cancellationOrigin: "SYSTEM",
      cancellationNote: "patient désactivé",
      cancelledAt: NOW,
      cancelledById: "u1",
      lateCancellation: false,
    });
  });

  it("never offers the sync's reason to a person", () => {
    expect(USER_CANCELLATION_REASONS).not.toContain("REFERENTIAL_SYNC");
    expect(USER_CANCELLATION_REASONS).toContain("PARTNER");
  });

  it("brings back only what the application cancelled", () => {
    expect(isSystemCancellation({ status: "CANCELLED", cancellationOrigin: "SYSTEM" })).toBe(true);
    expect(isSystemCancellation({ status: "CANCELLED", cancellationOrigin: "USER" })).toBe(false);
    // Cancelled before the origin was recorded: treated as a person's.
    expect(isSystemCancellation({ status: "CANCELLED", cancellationOrigin: null })).toBe(false);
    expect(isSystemCancellation({ status: "PLANNED", cancellationOrigin: "SYSTEM" })).toBe(false);
  });
});

describe("cancellationLabel", () => {
  it("names the reason, its note and whether it came late", () => {
    expect(cancellationLabel({ cancellationReason: "PARTNER", cancellationNote: null, lateCancellation: false })).toBe("Confiée à un confrère");
    expect(cancellationLabel({ cancellationReason: "PATIENT", cancellationNote: " ", lateCancellation: true })).toBe(
      "Demande du patient · tardive",
    );
    expect(
      cancellationLabel({ cancellationReason: "REFERENTIAL_SYNC", cancellationNote: "patient désactivé", lateCancellation: false }),
    ).toBe("Synchronisation du référentiel (patient désactivé)");
    expect(cancellationLabel({ cancellationReason: null, cancellationNote: null, lateCancellation: false })).toBe("Motif non renseigné");
  });
});

describe("patientCancellationStats", () => {
  const cancelled = (overrides: Partial<Parameters<typeof patientCancellationStats>[0][number]>) => ({
    status: "CANCELLED",
    cancellationOrigin: "USER" as const,
    cancellationReason: "PATIENT" as const,
    lateCancellation: false,
    ...overrides,
  });

  it("counts absences and the cancellations made for the patient, late ones apart", () => {
    expect(
      patientCancellationStats([
        { status: "NO_SHOW", cancellationOrigin: null, cancellationReason: null, lateCancellation: false },
        cancelled({ lateCancellation: true }),
        cancelled({ cancellationReason: "HOSPITALIZATION" }),
        cancelled({ cancellationReason: "OWN_MEANS" }),
        // Recorded before reasons existed: whose decision is unknown, counted apart.
        cancelled({ cancellationOrigin: null, cancellationReason: null }),
        cancelled({ cancellationOrigin: null, cancellationReason: null, lateCancellation: true }),
        // None of these says anything about the patient.
        cancelled({ cancellationOrigin: "SYSTEM", cancellationReason: "REFERENTIAL_SYNC" }),
        cancelled({ cancellationOrigin: "SYSTEM", cancellationReason: null }),
        cancelled({ cancellationReason: "PARTNER" }),
        cancelled({ cancellationReason: "REGULATION", lateCancellation: true }),
        cancelled({ cancellationReason: "FACILITY", lateCancellation: true }),
        cancelled({ cancellationReason: "DECEASED" }),
      ]),
    ).toEqual({ noShows: 1, lateCancellations: 1, cancellations: 3, withoutReason: 2 });
  });

  it("looks 90 days back", () => {
    expect(patientHistoryStart("2026-11-09")).toBe("2026-08-11");
  });
});
