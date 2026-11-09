import { beforeAll, describe, expect, it } from "vitest";
import { fromIsoDate } from "@/lib/time";
import {
  daysBetween,
  findPredecessor,
  findRenewal,
  formatRecurrenceSummary,
  formatWeekdays,
  isRenewalOf,
  mobilityModeWarning,
  needsRenewal,
  pickCurrentPrescription,
  prescriptionValidity,
  recurrenceCoverageNotice,
  recurrenceFormNotices,
  uncoveredDays,
  uncoveredText,
  validityLabel,
} from "./status";

// The first Date/Intl call of a process initialises ICU time zones, which takes
// several seconds on slow machines: pay it once here, outside the test timeouts.
beforeAll(() => {
  new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC" }).format(new Date("2026-01-01T00:00:00.000Z"));
}, 60_000);

const TODAY = "2026-11-02";

describe("prescriptionValidity", () => {
  it("classifies expired, expiring, valid and upcoming prescriptions", () => {
    expect(prescriptionValidity({ validFrom: "2026-01-01", validTo: "2026-11-01" }, TODAY)).toEqual({
      state: "expired",
      daysLeft: -1,
    });
    expect(prescriptionValidity({ validFrom: "2026-01-01", validTo: "2026-11-02" }, TODAY).state).toBe("expiring");
    expect(prescriptionValidity({ validFrom: "2026-01-01", validTo: "2026-11-16" }, TODAY)).toEqual({
      state: "expiring",
      daysLeft: 14,
    });
    expect(prescriptionValidity({ validFrom: "2026-01-01", validTo: "2026-11-17" }, TODAY).state).toBe("valid");
    expect(prescriptionValidity({ validFrom: "2026-11-10", validTo: "2027-02-01" }, TODAY).state).toBe("upcoming");
  });

  it("flags expired and expiring prescriptions for renewal", () => {
    expect(needsRenewal({ validFrom: "2026-01-01", validTo: "2026-10-01" }, TODAY)).toBe(true);
    expect(needsRenewal({ validFrom: "2026-01-01", validTo: "2026-11-10" }, TODAY)).toBe(true);
    expect(needsRenewal({ validFrom: "2026-01-01", validTo: "2027-01-10" }, TODAY)).toBe(false);
  });

  it("labels the validity in French", () => {
    expect(validityLabel({ validFrom: "2026-01-01", validTo: "2026-10-01" }, TODAY)).toBe("Expirée le 01/10/2026");
    expect(validityLabel({ validFrom: "2026-01-01", validTo: "2026-11-02" }, TODAY)).toBe("Expire aujourd'hui");
    expect(validityLabel({ validFrom: "2026-01-01", validTo: "2026-11-03" }, TODAY)).toBe("Expire demain");
    expect(validityLabel({ validFrom: "2026-01-01", validTo: "2026-11-12" }, TODAY)).toBe("Expire dans 10 j");
    expect(validityLabel({ validFrom: "2026-01-01", validTo: "2027-03-31" }, TODAY)).toBe("Valide jusqu'au 31/03/2027");
    expect(validityLabel({ validFrom: "2026-12-01", validTo: "2027-03-31" }, TODAY)).toBe(
      "Valide à partir du 01/12/2026",
    );
  });

  it("counts days across a DST change", () => {
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
  });
});

describe("pickCurrentPrescription", () => {
  const p = (id: string, from: string, to: string) => ({ id, validFrom: fromIsoDate(from), validTo: fromIsoDate(to) });

  it("prefers the prescription valid today that ends last", () => {
    const list = [p("old", "2026-01-01", "2026-06-30"), p("a", "2026-09-01", "2026-12-31"), p("b", "2026-10-01", "2027-03-31")];
    expect(pickCurrentPrescription(list, TODAY)?.id).toBe("b");
  });

  it("falls back on the next upcoming, then on the last expired", () => {
    expect(
      pickCurrentPrescription([p("old", "2026-01-01", "2026-06-30"), p("next", "2026-12-01", "2027-01-31"), p("later", "2027-02-01", "2027-05-31")], TODAY)?.id,
    ).toBe("next");
    expect(pickCurrentPrescription([p("x", "2025-01-01", "2025-06-30"), p("y", "2026-01-01", "2026-06-30")], TODAY)?.id).toBe("y");
    expect(pickCurrentPrescription([], TODAY)).toBeNull();
  });
});

describe("mobilityModeWarning", () => {
  it("warns on lying patients with a seated prescription and the reverse", () => {
    expect(mobilityModeWarning("LYING", "TAP")).toMatch(/allongé/);
    expect(mobilityModeWarning("SEATED", "AMBULANCE")).toMatch(/assis/);
  });

  it("accepts consistent combinations and wheelchairs", () => {
    expect(mobilityModeWarning("LYING", "AMBULANCE")).toBeNull();
    expect(mobilityModeWarning("SEATED", "TAP")).toBeNull();
    expect(mobilityModeWarning("WHEELCHAIR", "TAP")).toBeNull();
    expect(mobilityModeWarning("WHEELCHAIR", "AMBULANCE")).toBeNull();
  });
});

describe("recurrenceCoverageNotice (patient page)", () => {
  const longPmt = { validFrom: "2026-09-01", validTo: "2027-02-28" };
  const endingPmt = { validFrom: "2026-05-01", validTo: "2026-11-10" };
  const renewal = { validFrom: "2026-11-11", validTo: "2027-05-10" };

  it("stays silent on an open-ended recurrence while its PMT is far from its end", () => {
    expect(recurrenceCoverageNotice({ startDate: "2026-09-01", endDate: null }, longPmt, TODAY)).toBeNull();
    expect(recurrenceCoverageNotice({ startDate: "2026-09-01", endDate: "2027-06-30" }, longPmt, TODAY)).toBeNull();
  });

  it("ignores a start before the PMT when that period is over", () => {
    expect(recurrenceCoverageNotice({ startDate: "2026-01-05", endDate: null }, longPmt, TODAY)).toBeNull();
  });

  it("warns when the PMT ends soon and the recurrence runs past it", () => {
    expect(recurrenceCoverageNotice({ startDate: "2026-05-01", endDate: null }, endingPmt, TODAY)).toEqual({
      tone: "warning",
      text: "Expire dans 8 j (10/11/2026) : sans renouvellement, plus de course après cette date.",
    });
    expect(
      recurrenceCoverageNotice({ startDate: "2026-05-01", endDate: "2026-11-06" }, endingPmt, TODAY),
    ).toBeNull();
  });

  it("is calm when the renewal is already registered", () => {
    const notice = recurrenceCoverageNotice({ startDate: "2026-05-01", endDate: null }, endingPmt, TODAY, renewal);
    expect(notice?.tone).toBe("info");
    expect(notice?.text).toBe(
      "PMT renouvelée (11/11/2026 → 10/05/2027) : les courses continuent dessus ; rattachez-y la récurrence.",
    );
  });

  it("flags an expired PMT, less loudly when renewed", () => {
    const expired = { validFrom: "2026-03-01", validTo: "2026-10-31" };
    expect(recurrenceCoverageNotice({ startDate: "2026-03-01", endDate: null }, expired, TODAY)?.tone).toBe("danger");
    expect(
      recurrenceCoverageNotice({ startDate: "2026-03-01", endDate: null }, expired, TODAY, { validFrom: "2026-11-01", validTo: "2027-04-30" })
        ?.tone,
    ).toBe("warning");
  });

  it("warns when the PMT only starts later", () => {
    expect(
      recurrenceCoverageNotice({ startDate: "2026-11-02", endDate: null }, { validFrom: "2026-11-16", validTo: "2027-05-15" }, TODAY),
    ).toEqual({ tone: "warning", text: "La PMT ne commence que le 16/11/2026 : pas de course avant cette date." });
  });

  it("stays silent before a renewal attached early, while the PMT it renews covers the days before", () => {
    const early = { validFrom: "2026-11-11", validTo: "2027-05-10" };
    expect(recurrenceCoverageNotice({ startDate: "2026-05-01", endDate: null }, early, TODAY, null, endingPmt)).toBeNull();
    // A gap between the two: only those days are flagged.
    expect(
      recurrenceCoverageNotice({ startDate: "2026-05-01", endDate: null }, { ...early, validFrom: "2026-11-13" }, TODAY, null, endingPmt),
    ).toEqual({
      tone: "warning",
      text: "Courses sur la PMT précédente jusqu'au 10/11/2026, puis aucune PMT du 11/11/2026 au 12/11/2026 : pas de course ces jours-là.",
    });
  });

  it("says when a renewal starting late leaves days without trip", () => {
    const notice = recurrenceCoverageNotice({ startDate: "2026-05-01", endDate: null }, endingPmt, TODAY, {
      validFrom: "2026-11-14",
      validTo: "2027-05-13",
    });
    expect(notice).toEqual({
      tone: "warning",
      text: "PMT renouvelée (14/11/2026 → 13/05/2027) : les courses continuent dessus ; rattachez-y la récurrence. Aucune PMT du 11/11/2026 au 13/11/2026 : pas de course ces jours-là.",
    });
  });

  it("says nothing about a recurrence that has ended", () => {
    expect(recurrenceCoverageNotice({ startDate: "2026-01-01", endDate: "2026-10-01" }, endingPmt, TODAY)).toBeNull();
  });
});

describe("recurrenceFormNotices (recurrence form)", () => {
  const prescription = { validFrom: "2026-09-01", validTo: "2027-02-28" };

  it("is silent when the recurrence stays inside the validity", () => {
    expect(recurrenceFormNotices({ startDate: "2026-11-02", endDate: "2027-02-28" }, prescription, TODAY)).toEqual([]);
  });

  it("gives an open-ended recurrence an info hint, not a warning", () => {
    expect(recurrenceFormNotices({ startDate: "2026-11-02", endDate: null }, prescription, TODAY)).toEqual([
      {
        tone: "info",
        text: "Courses générées jusqu'au 28/02/2027 (fin de la prescription) ; pour la suite, saisissez le renouvellement : les courses continueront dessus.",
      },
    ]);
  });

  it("warns when trips to come fall before the validity, not for a past start", () => {
    const upcoming = { validFrom: "2026-11-20", validTo: "2027-02-28" };
    expect(recurrenceFormNotices({ startDate: "2026-11-02", endDate: "2027-01-31" }, upcoming, TODAY)).toEqual([
      {
        tone: "warning",
        text: "La prescription ne commence que le 20/11/2026 : aucune course ne sera générée avant cette date.",
      },
    ]);
    expect(recurrenceFormNotices({ startDate: "2026-01-05", endDate: "2027-01-31" }, prescription, TODAY)).toEqual([]);
  });

  it("flags a prescription that has already expired", () => {
    const notices = recurrenceFormNotices({ startDate: "2026-11-02", endDate: null }, { validFrom: "2026-01-01", validTo: "2026-10-31" }, TODAY);
    expect(notices.map((n) => n.tone)).toEqual(["danger"]);
  });

  it("tells that the sessions use the PMT renewed before, and the renewal after", () => {
    const renewal = { validFrom: "2026-11-20", validTo: "2027-05-19", previous: { validFrom: "2026-05-20", validTo: "2026-11-19" } };
    expect(recurrenceFormNotices({ startDate: "2026-11-02", endDate: "2027-05-19" }, renewal, TODAY)).toEqual([
      {
        tone: "info",
        text: "Avant le 20/11/2026, les courses restent sur la prescription précédente (jusqu'au 19/11/2026).",
      },
    ]);
    const expired = { validFrom: "2026-01-01", validTo: "2026-10-31", next: { validFrom: "2026-11-04", validTo: "2027-05-03" } };
    expect(recurrenceFormNotices({ startDate: "2026-11-02", endDate: null }, expired, TODAY)).toEqual([
      {
        tone: "warning",
        text: "Cette prescription a expiré le 31/10/2026 ; les courses continuent sur son renouvellement (04/11/2026 → 03/05/2027) ; aucune PMT du 02/11/2026 au 03/11/2026 : pas de course ces jours-là.",
      },
    ]);
  });
});

describe("renewals", () => {
  const p = (id: string, mode: "TAP" | "AMBULANCE", from: string, to: string) => ({
    id,
    mode,
    validFrom: fromIsoDate(from),
    validTo: fromIsoDate(to),
  });
  const current = p("a", "TAP", "2026-05-01", "2026-11-07");

  it("recognises a later same-mode prescription taking over within a month of the end", () => {
    expect(isRenewalOf(current, p("b", "TAP", "2026-11-08", "2027-05-07"))).toBe(true);
    expect(isRenewalOf(current, p("overlap", "TAP", "2026-10-15", "2027-04-14"))).toBe(true);
    // Renewed a few days late: still the renewal (the days in between have no trip).
    expect(isRenewalOf(current, p("gap", "TAP", "2026-11-12", "2027-05-11"))).toBe(true);
    expect(isRenewalOf(current, p("limit", "TAP", "2026-12-09", "2027-06-08"))).toBe(true);
    expect(isRenewalOf(current, p("too late", "TAP", "2026-12-10", "2027-06-09"))).toBe(false);
    // Started before it: a concurrent prescription, not its renewal.
    expect(isRenewalOf(current, p("before", "TAP", "2026-04-01", "2027-04-01"))).toBe(false);
    expect(isRenewalOf(current, p("mode", "AMBULANCE", "2026-11-08", "2027-05-07"))).toBe(false);
    expect(isRenewalOf(current, p("shorter", "TAP", "2026-06-01", "2026-11-07"))).toBe(false);
    expect(isRenewalOf(current, current)).toBe(false);
  });

  it("picks the renewal taking over nearest to the end, the longest on a tie", () => {
    const list = [current, p("b", "TAP", "2026-11-08", "2027-02-07"), p("c", "TAP", "2026-11-01", "2027-05-07")];
    expect(findRenewal(current, list)?.id).toBe("b");
    expect(findRenewal(current, [current, p("b", "TAP", "2026-11-08", "2027-02-07"), p("d", "TAP", "2026-11-08", "2027-05-07")])?.id).toBe("d");
    expect(findRenewal(current, [current])).toBeNull();
  });

  it("never takes another series' prescription for a renewal", () => {
    const dialysis = { ...current, recurrences: [{ facilityId: "dialysis" }] };
    const radiotherapy = { ...p("radio", "TAP", "2026-10-01", "2027-01-31"), recurrences: [{ facilityId: "radiotherapy" }] };
    expect(findRenewal(dialysis, [dialysis, radiotherapy])).toBeNull();
    // Without recurrences to compare with (all moved already), the dates decide.
    expect(findRenewal(current, [current, radiotherapy])?.id).toBe("radio");
    // The PMT a recurrence was attached to early comes after the one it renews.
    const renewal = { ...p("b", "TAP", "2026-11-08", "2027-05-07"), recurrences: [{ facilityId: "dialysis" }] };
    expect(findPredecessor(renewal, [current, renewal])?.id).toBe("a");
    expect(findPredecessor(renewal, [{ ...current, recurrences: [{ facilityId: "radiotherapy" }] }, renewal])).toBeNull();
  });

  it("names the days left without any PMT between two prescriptions, from today on", () => {
    expect(uncoveredDays("2026-11-01", "2026-11-05", TODAY)).toEqual({ from: "2026-11-02", to: "2026-11-04" });
    expect(uncoveredDays("2026-10-20", "2026-11-05", TODAY)).toEqual({ from: TODAY, to: "2026-11-04" });
    expect(uncoveredDays("2026-11-01", "2026-11-02", TODAY)).toBeNull();
    expect(uncoveredDays("2026-10-01", "2026-10-05", TODAY)).toBeNull();
    expect(uncoveredText({ from: "2026-11-02", to: "2026-11-04" })).toBe(
      "aucune PMT du 02/11/2026 au 04/11/2026 : pas de course ces jours-là",
    );
    expect(uncoveredText({ from: "2026-11-04", to: "2026-11-04" })).toBe("aucune PMT le 04/11/2026 : pas de course ce jour-là");
  });

  it("drops the red badge once renewed", () => {
    expect(needsRenewal({ validFrom: "2026-05-01", validTo: "2026-11-07" }, TODAY)).toBe(true);
    expect(needsRenewal({ validFrom: "2026-05-01", validTo: "2026-11-07" }, TODAY, true)).toBe(false);
  });
});

describe("recurrence summary", () => {
  it("formats weekdays in ISO order without duplicates", () => {
    expect(formatWeekdays([5, 1, 3, 3])).toBe("Lun Mer Ven");
    expect(formatWeekdays([7, 0, 8])).toBe("Dim");
  });

  it("formats « Lun Mer Ven 07:30 — Dialyse »", () => {
    expect(formatRecurrenceSummary({ weekdays: [1, 3, 5], appointmentMinute: 450, label: "Dialyse" })).toBe(
      "Lun Mer Ven 07:30 — Dialyse",
    );
    expect(
      formatRecurrenceSummary({ weekdays: [2], appointmentMinute: 840, label: " ", facilityName: "Centre de dialyse de Gap" }),
    ).toBe("Mar 14:00 — Centre de dialyse de Gap");
    expect(formatRecurrenceSummary({ weekdays: [4], appointmentMinute: 600, label: null })).toBe("Jeu 10:00");
  });
});
