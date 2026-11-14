import { describe, expect, it } from "vitest";
import { fromIsoDate } from "@/lib/time";
import { dayCancelLabel, dayCancelQuestion, upcomingDays, type UpcomingTripInput } from "./upcoming";

function trip(id: string, date: string, overrides: Partial<UpcomingTripInput> = {}): UpcomingTripInput {
  return {
    id,
    serviceDate: fromIsoDate(date),
    direction: "OUTBOUND",
    status: "PLANNED",
    appointmentMinute: 450,
    readyMinute: null,
    plannedPickupMinute: null,
    routeId: null,
    oneOffAddress: false,
    notes: null,
    shared: false,
    sharingStatus: "NOT_PROPOSED",
    cancellationReason: null,
    cancellationOrigin: null,
    cancellationNote: null,
    lateCancellation: false,
    facility: { name: "Centre de dialyse" },
    ...overrides,
  };
}

const back = (id: string, date: string, overrides: Partial<UpcomingTripInput> = {}) =>
  trip(id, date, { direction: "RETURN", appointmentMinute: null, readyMinute: 690, ...overrides });

describe("upcomingDays", () => {
  it("groups the trips by day and time, and says what each allows", () => {
    const days = upcomingDays(
      [
        back("r2", "2026-11-16"),
        trip("a1", "2026-11-14", { routeId: "route1", plannedPickupMinute: 420 }),
        back("r1", "2026-11-14", { status: "DROPPED_OFF" }),
        trip("a2", "2026-11-16", {
          status: "CANCELLED",
          cancellationReason: "HOSPITALIZATION",
          cancellationNote: "du 16/11/2026 au 18/11/2026",
        }),
        trip("a3", "2026-11-17", { status: "CANCELLED", cancellationReason: "HOSPITALIZATION", cancellationOrigin: "SYSTEM" }),
      ],
      [{ kind: "HOSPITALIZATION", startDate: "2026-11-16", endDate: "2026-11-18" }],
      "p1",
      "2026-11-14",
    );
    expect(days.map((d) => [d.date, d.today, d.absence, d.trips.map((t) => t.id)])).toEqual([
      ["2026-11-14", true, null, ["a1", "r1"]],
      ["2026-11-16", false, "Hospitalisation", ["a2", "r2"]],
      ["2026-11-17", false, "Hospitalisation", ["a3"]],
    ]);
    // A day of absence: shortening the absence brings the trip back, not « Rétablir » (whoever cancelled it).
    expect(days[2]?.trips[0]?.canRestore).toBe(false);
    const [first, second] = days;
    expect(first?.trips[0]).toMatchObject({ canCancel: true, canRestore: false, inRoute: true, plannedText: "prise en charge 07:00" });
    expect(first?.trips[1]).toMatchObject({ canCancel: false, canRestore: false, editHref: null, timeText: "Fin de séance 11:30" });
    expect(second?.trips[0]).toMatchObject({
      canCancel: false,
      canRestore: false,
      cancellation: "Hospitalisation (du 16/11/2026 au 18/11/2026)",
      ariaName: "du 16/11/2026 (aller)",
    });
    expect(second?.coursesHref).toBe("/courses?date=2026-11-16&patient=p1");
  });

  it("restores a cancelled trip only outside an absence and a closure of its facility, as restoreTrip (PAT-02, PAT-03)", () => {
    const closed = { name: "Hôpital de jour", closures: [{ startDate: fromIsoDate("2026-11-19"), endDate: fromIsoDate("2026-11-19") }] };
    const days = upcomingDays(
      [
        trip("free", "2026-11-15", { status: "CANCELLED", cancellationReason: "PATIENT", cancellationOrigin: "USER" }),
        trip("holiday", "2026-11-16", { status: "CANCELLED", cancellationReason: "PATIENT", cancellationOrigin: "USER" }),
        trip("closed", "2026-11-19", { status: "CANCELLED", cancellationReason: "FACILITY_CLOSED", cancellationOrigin: "SYSTEM", facility: closed }),
        trip("open", "2026-11-20", { status: "CANCELLED", cancellationReason: "PATIENT", cancellationOrigin: "USER", facility: closed }),
      ],
      [{ kind: "HOLIDAY", startDate: "2026-11-16", endDate: "2026-11-16" }],
      "p1",
      "2026-11-14",
    );
    expect(days.map((d) => [d.trips[0]?.id, d.absence, d.trips[0]?.canRestore])).toEqual([
      ["free", null, true],
      // The record names the kind of absence.
      ["holiday", "Vacances", false],
      ["closed", null, false],
      ["open", null, true],
    ]);
  });

  it("never offers to restore a trip of a past day", () => {
    const [day] = upcomingDays([trip("a", "2026-11-13", { status: "CANCELLED" })], [], "p1", "2026-11-14");
    expect(day?.trips[0]?.canRestore).toBe(false);
  });
});

describe("« Annuler ce jour »", () => {
  it("says aller et retour when both legs are open", () => {
    expect(dayCancelLabel([{ direction: "OUTBOUND" }, { direction: "RETURN" }])).toBe("Annuler ce jour (aller et retour)");
    expect(dayCancelLabel([{ direction: "RETURN" }])).toBe("Annuler ce jour");
  });

  it("asks what goes, and the routes they leave", () => {
    expect(
      dayCancelQuestion("16/11/2026", [
        { direction: "OUTBOUND", inRoute: true },
        { direction: "RETURN", inRoute: false },
      ]),
    ).toBe("Annuler l'aller et le retour du 16/11/2026 ? 1 course sera retirée de sa tournée.");
    expect(dayCancelQuestion("16/11/2026", [{ direction: "RETURN", inRoute: false }])).toBe("Annuler le retour du 16/11/2026 ?");
  });
});
