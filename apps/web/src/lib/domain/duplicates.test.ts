import { describe, expect, it } from "vitest";
import {
  conflictLabel,
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
});
