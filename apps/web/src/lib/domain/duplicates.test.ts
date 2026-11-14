import { describe, expect, it } from "vitest";
import {
  calendarRestoreBlocker,
  calendarWarnings,
  conflictLabel,
  coveringPeriod,
  nameKey,
  phoneKey,
  recurrenceOverlaps,
  restoreBlocker,
  similarPatients,
  tripConflicts,
  type DayTrip,
  type OverlapRecurrence,
} from "./duplicates";

function trip(id: string, overrides: Partial<DayTrip> = {}): DayTrip {
  return {
    id,
    patientId: "p1",
    recurrenceId: "rec1",
    facilityId: "dialysis",
    direction: "OUTBOUND",
    status: "PLANNED",
    appointmentMinute: 450,
    readyMinute: null,
    ...overrides,
  };
}

describe("tripConflicts", () => {
  // Dialysis 07:30 → 11:30 (recurrence), both legs.
  const outbound = trip("a1");
  const back = trip("r1", { direction: "RETURN", appointmentMinute: null, readyMinute: 690 });

  it("flags a second trip of the patient on the same leg that day", () => {
    const oneOff = trip("x1", { recurrenceId: null, facilityId: "clinic", appointmentMinute: 420 });
    const conflicts = tripConflicts(oneOff, [outbound, back, oneOff]);
    expect(conflicts).toEqual([{ kind: "same_leg", otherId: "a1", minute: 450 }]);
    // An appointment at 08:00 elsewhere falls during the dialysis too.
    expect(tripConflicts({ ...oneOff, appointmentMinute: 480 }, [outbound, back]).map((c) => c.kind)).toEqual([
      "same_leg",
      "during_session",
    ]);
    expect(conflictLabel(conflicts[0]!, "OUTBOUND")).toBe("Le patient a déjà un aller ce jour (RDV 07:30)");
  });

  it("flags a consultation during another care session", () => {
    const consultation = trip("x1", { direction: "RETURN", recurrenceId: null, facilityId: "clinic", appointmentMinute: null, readyMinute: 600 });
    const conflicts = tripConflicts(consultation, [outbound, back, consultation]);
    // 1 h 30 before the end of the dialysis, elsewhere: not the same leg, but during the session.
    expect(conflicts).toEqual([{ kind: "during_session", start: 450, end: 690 }]);
    expect(conflictLabel(conflicts[0]!, "RETURN")).toBe("Pendant une autre séance du patient (07:30 → 11:30)");
  });

  it("flags a second trip to the same facility whatever the time", () => {
    const again = trip("x1", { recurrenceId: null, appointmentMinute: 900 });
    expect(tripConflicts(again, [outbound, back, again])).toEqual([{ kind: "same_leg", otherId: "a1", minute: 450 }]);
  });

  it("does not flag two cares of the day at other places and times", () => {
    // Dialysis 07:30 → 11:30 at one place, a consultation 15:00 → 16:00 elsewhere (two recurrences).
    const consultation = trip("c1", { recurrenceId: "rec2", facilityId: "clinic", appointmentMinute: 900 });
    const consultationBack = trip("c2", { direction: "RETURN", recurrenceId: "rec2", facilityId: "clinic", appointmentMinute: null, readyMinute: 960 });
    const day = [outbound, back, consultation, consultationBack];
    for (const t of day) expect(tripConflicts(t, day)).toEqual([]);
  });

  it("says nothing for the two legs of one care, another patient, or a cancelled trip", () => {
    expect(tripConflicts(outbound, [outbound, back])).toEqual([]);
    expect(tripConflicts(trip("x1", { patientId: "p2" }), [outbound, back])).toEqual([]);
    expect(tripConflicts(trip("x1"), [trip("a1", { status: "CANCELLED" })])).toEqual([]);
    expect(tripConflicts(trip("x1", { status: "CANCELLED" }), [outbound])).toEqual([]);
  });
});

describe("recurrenceOverlaps", () => {
  const rec = (id: string, overrides: Partial<OverlapRecurrence> = {}): OverlapRecurrence => ({
    id,
    active: true,
    weekdays: [1, 3, 5],
    appointmentMinute: 450,
    sessionMinutes: 240,
    startDate: "2026-01-01",
    endDate: null,
    ...overrides,
  });

  it("tells two rhythms every other week on alternate weeks apart, and finds explicit dates on a common day (PAT-05)", () => {
    // Weeks of 2026-11-02 and of 2026-11-09, every other week: never the same Monday.
    const even = rec("even", { weekdays: [1], intervalWeeks: 2, startDate: "2026-11-02" });
    const odd = rec("odd", { weekdays: [1], intervalWeeks: 2, startDate: "2026-11-09" });
    expect(recurrenceOverlaps([even, odd]).size).toBe(0);
    expect(recurrenceOverlaps([even, rec("weekly", { weekdays: [1] })]).get("even")).toEqual(["weekly"]);
    const dated = rec("dated", { sessionDates: ["2026-11-16"], startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(recurrenceOverlaps([even, dated]).get("dated")).toEqual(["even"]);
    expect(recurrenceOverlaps([odd, dated]).size).toBe(0);
  });

  it("finds two active recurrences on a common day, period and time slot", () => {
    const overlaps = recurrenceOverlaps([rec("a"), rec("b", { weekdays: [5, 6], appointmentMinute: 600 })]);
    expect(overlaps).toEqual(new Map([["a", ["b"]], ["b", ["a"]]]));
  });

  it("ignores other days, another time slot, a period over, or an inactive recurrence", () => {
    expect(recurrenceOverlaps([rec("a"), rec("b", { weekdays: [2, 4] })]).size).toBe(0);
    expect(recurrenceOverlaps([rec("a"), rec("b", { appointmentMinute: 690 })]).size).toBe(0);
    expect(recurrenceOverlaps([rec("a", { endDate: "2026-03-31" }), rec("b", { startDate: "2026-04-01" })]).size).toBe(0);
    expect(recurrenceOverlaps([rec("a"), rec("b", { active: false })]).size).toBe(0);
  });

  it("compares the sessions of each common day with that weekday's own time (PAT-05)", () => {
    const hour = (appointmentMinute: number) => ({ appointmentMinute, sessionMinutes: 60 });
    // Mon + Wed 08:00 for 1 h, Wednesday at 14:00.
    const own = rec("own", { weekdays: [1, 3], ...hour(480), daySchedules: [{ weekday: 3, appointmentMinute: 840 }] });
    // Wed 08:00: Wednesday's session of `own` is at 14:00, no overlap.
    expect(recurrenceOverlaps([own, rec("morning", { weekdays: [3], ...hour(480) })]).size).toBe(0);
    // Wed 14:00: the same session as Wednesday's of `own`.
    expect(recurrenceOverlaps([own, rec("afternoon", { weekdays: [3], ...hour(840) })]).get("own")).toEqual(["afternoon"]);
    // Every other week, and on explicit dates: the date's weekday decides the time too (2026-11-18 is a Wednesday).
    const everyOther = rec("every-other", { weekdays: [3], intervalWeeks: 2, startDate: "2026-11-16", ...hour(840) });
    expect(recurrenceOverlaps([own, everyOther]).get("every-other")).toEqual(["own"]);
    const dated = rec("dated", { sessionDates: ["2026-11-18"], startDate: "2026-11-18", endDate: "2026-11-18", ...hour(480) });
    expect(recurrenceOverlaps([own, dated]).size).toBe(0);
  });
});

describe("similarPatients", () => {
  const existing = [
    { id: "1", firstName: "Hélène", lastName: "Dupont-Martin", phone: "06 12 34 56 78", address: "4 rue des Lilas", postalCode: "13012" },
    { id: "2", firstName: "Paul", lastName: "Roux", phone: null, address: "12, Rue de l'Église", postalCode: "04100" },
    { id: "3", firstName: "Jean", lastName: "Blanc", phone: "0491000000", address: "1 avenue A", postalCode: "13001" },
  ];

  it("matches the name without accents nor word order, the phone in any format, or the address", () => {
    const found = (candidate: Parameters<typeof similarPatients>[0]) =>
      similarPatients(candidate, existing).map(({ patient, reasons }) => [patient.id, reasons]);
    expect(found({ firstName: "helene", lastName: "DUPONT MARTIN", phone: null, address: "x", postalCode: "13001" })).toEqual([["1", ["name"]]]);
    expect(found({ firstName: "Anne", lastName: "Neuve", phone: "+33 6 12 34 56 78", address: "x", postalCode: "13001" })).toEqual([["1", ["phone"]]]);
    expect(found({ firstName: "Anne", lastName: "Neuve", phone: null, address: "12 rue de l'eglise", postalCode: "04100" })).toEqual([
      ["2", ["address"]],
    ]);
    expect(found({ firstName: "Anne", lastName: "Neuve", phone: "06", address: "x", postalCode: "13001" })).toEqual([]);
  });

  it("normalises names and phones", () => {
    expect(nameKey("Marie-Thérèse", "  BENHAMOU ")).toBe("benhamou marie therese");
    expect(phoneKey("04.91.00.00.00")).toBe("491000000");
    expect(phoneKey("12 34")).toBeNull();
  });
});

describe("restoreBlocker", () => {
  const cancelled = {
    serviceDate: "2026-11-12",
    payer: "CPAM" as const,
    patientActive: true,
    recurrenceActive: true,
    prescription: { validFrom: "2026-11-01", validTo: "2026-11-30" },
  };

  it("lets a trip come back when nothing stands in the way", () => {
    expect(restoreBlocker(cancelled, "2026-11-09")).toBeNull();
    expect(restoreBlocker({ ...cancelled, recurrenceActive: null, payer: "PRIVATE", prescription: null }, "2026-11-09")).toBeNull();
  });

  it("refuses a past date, an inactive patient or recurrence, a CPAM trip without a valid prescription", () => {
    expect(restoreBlocker(cancelled, "2026-11-13")).toMatch(/Date passée/);
    expect(restoreBlocker({ ...cancelled, patientActive: false }, "2026-11-09")).toMatch(/patient est désactivé/);
    expect(restoreBlocker({ ...cancelled, recurrenceActive: false }, "2026-11-09")).toMatch(/récurrence/);
    expect(restoreBlocker({ ...cancelled, prescription: null }, "2026-11-09")).toMatch(/prescription valide/);
    expect(restoreBlocker({ ...cancelled, prescription: { validFrom: "2026-11-01", validTo: "2026-11-11" } }, "2026-11-09")).toMatch(
      /prescription valide/,
    );
  });

  it("refuses a day the patient is absent or the facility closed, whoever cancelled the trip (PAT-02, PAT-03)", () => {
    const absence = { kind: "HOSPITALIZATION" as const, startDate: "2026-11-11", endDate: "2026-11-13" };
    expect(restoreBlocker({ ...cancelled, absence }, "2026-11-09")).toBe(
      "Le patient est absent ce jour-là (hospitalisation du 11/11/2026 au 13/11/2026)\u00a0: raccourcissez ou supprimez l'absence sur sa fiche d'abord.",
    );
    // Holidays and other absences: « absence du patient », never more on a planning screen.
    expect(calendarRestoreBlocker({ ...absence, kind: "HOLIDAY" }, null)).toMatch(/^Le patient est absent ce jour-là \(absence du patient du 11/);
    expect(restoreBlocker({ ...cancelled, closure: { startDate: "2026-11-12", endDate: "2026-11-12" } }, "2026-11-09")).toBe(
      "L'établissement est fermé ce jour-là (fermeture le 12/11/2026)\u00a0: supprimez la fermeture sur sa fiche d'abord.",
    );
    expect(calendarRestoreBlocker(null, null)).toBeNull();
  });
});

describe("calendarWarnings", () => {
  it("names the absence (planning wording) and the closed facility of a trip created or moved there", () => {
    expect(
      calendarWarnings(
        { kind: "HOLIDAY", startDate: "2026-11-16", endDate: "2026-11-20" },
        { facilityName: "Hôpital de jour d'Aix", startDate: "2026-11-19", endDate: "2026-11-19" },
      ),
    ).toEqual([
      "le patient est absent ce jour-là (absence du patient du 16/11/2026 au 20/11/2026)",
      "Hôpital de jour d'Aix est fermé ce jour-là (fermeture le 19/11/2026)",
    ]);
    expect(calendarWarnings(null, null)).toEqual([]);
  });
});

describe("coveringPeriod", () => {
  it("finds the period covering a date, bounds included", () => {
    const periods = [
      { id: "a", startDate: "2026-11-10", endDate: "2026-11-12" },
      { id: "b", startDate: "2026-11-20", endDate: "2026-11-20" },
    ];
    expect(coveringPeriod(periods, "2026-11-12")?.id).toBe("a");
    expect(coveringPeriod(periods, "2026-11-20")?.id).toBe("b");
    expect(coveringPeriod(periods, "2026-11-13")).toBeNull();
  });
});
