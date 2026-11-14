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
    // Cancelled by the application for the absence: shortening the absence brings it back, not « Rétablir ».
    expect(days[2]?.trips[0]?.canRestore).toBe(false);
    const [first, second] = days;
    expect(first?.trips[0]).toMatchObject({ canCancel: true, canRestore: false, inRoute: true, plannedText: "prise en charge 07:00" });
    expect(first?.trips[1]).toMatchObject({ canCancel: false, canRestore: false, editHref: null, timeText: "Fin de séance 11:30" });
    expect(second?.trips[0]).toMatchObject({
      canCancel: false,
      canRestore: true,
      cancellation: "Hospitalisation (du 16/11/2026 au 18/11/2026)",
      ariaName: "du 16/11/2026 (aller)",
    });
    expect(second?.coursesHref).toBe("/courses?date=2026-11-16&patient=p1");
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
