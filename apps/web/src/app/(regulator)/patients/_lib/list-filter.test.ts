import { describe, expect, it } from "vitest";
import { awaitingRenewal, isFiltered, parsePatientFilter, patientOrderBy, patientParams, patientWhere, searchTerms } from "./list-filter";

const TODAY = "2026-11-10";
const parse = (query: string) => parsePatientFilter(Object.fromEntries(new URLSearchParams(query)));

describe("patient search terms", () => {
  it("looks for every word without accents", () => {
    expect(searchTerms("  Hélène  Laragne-Montéglin ")).toEqual(["helene", "laragne-monteglin"]);
    expect(searchTerms("Œuvray")).toEqual(["oeuvray"]);
  });

  it("reads a phone number or a postal code as one term of digits", () => {
    expect(searchTerms("06 12 34")).toEqual(["061234"]);
    expect(searchTerms("+33 6 12 34 56 78")).toEqual(["0612345678"]);
    expect(searchTerms("04.92.51")).toEqual(["049251"]);
    expect(searchTerms("13006")).toEqual(["13006"]);
    // Words and digits together: each is a word.
    expect(searchTerms("dupont 0612")).toEqual(["dupont", "0612"]);
  });
});

describe("patient list filters", () => {
  it("shows active patients by name by default", () => {
    const filter = parse("");
    expect(filter).toEqual({ q: "", status: "actifs", prescription: null, facility: null, mobility: null, sort: "nom" });
    expect(isFiltered(filter)).toBe(false);
    expect(isFiltered(parse("tri=ville"))).toBe(false);
    expect(patientWhere(filter, TODAY)).toEqual({ active: true });
    expect(patientOrderBy("nom")).toEqual([{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }]);
  });

  it("searches the normalized key, with the status, the mobility and the facility of an active recurrence", () => {
    expect(patientWhere(parse("q=Hélène&statut=tous&mobilite=LYING&etablissement=fac_1"), TODAY)).toEqual({
      mobility: "LYING",
      AND: [{ searchText: { contains: "helene" } }, { recurrences: { some: { active: true, facilityId: "fac_1" } } }],
    });
    expect(patientWhere(parse("statut=inactifs"), TODAY)).toEqual({ active: false });
    expect(parse("mobilite=FLYING&tri=x&statut=?").mobility).toBeNull();
  });

  it("finds the prescriptions to renew and the patients without a valid one", () => {
    const today = new Date("2026-11-10T00:00:00.000Z");
    const limit = new Date("2026-11-24T00:00:00.000Z");
    // The candidates only: the page keeps those awaitingRenewal says.
    expect(patientWhere(parse("pmt=a-renouveler"), TODAY).AND).toEqual([
      { prescriptions: { some: { validFrom: { lte: today }, validTo: { gte: today, lte: limit } } } },
    ]);
    expect(patientWhere(parse("pmt=sans"), TODAY).AND).toEqual([
      { prescriptions: { none: { validFrom: { lte: today }, validTo: { gte: today } } } },
    ]);
  });

  it("keeps the filters in the page links, defaults left out", () => {
    expect(patientParams(parse("q=gap&statut=actifs&tri=ville&pmt=sans"))).toEqual({
      q: "gap",
      statut: null,
      pmt: "sans",
      etablissement: null,
      mobilite: null,
      tri: "ville",
    });
    expect(patientOrderBy("recent")).toEqual([{ createdAt: "desc" }, { id: "asc" }]);
  });
});

describe("awaitingRenewal (the red «\u202fExpire dans N j\u202f» badge)", () => {
  const pmt = (id: string, mode: "TAP" | "AMBULANCE", from: string, to: string, facilities: string[] = []) => ({
    id,
    mode,
    validFrom: new Date(`${from}T00:00:00.000Z`),
    validTo: new Date(`${to}T00:00:00.000Z`),
    recurrences: facilities.map((facilityId) => ({ facilityId })),
  });

  it("keeps a prescription ending within 14 days that nothing renews", () => {
    expect(awaitingRenewal([pmt("a", "TAP", "2026-08-01", "2026-11-15")], TODAY)).toBe(true);
    // Not yet within the warning period, or already over: not this filter.
    expect(awaitingRenewal([pmt("a", "TAP", "2026-08-01", "2026-12-31")], TODAY)).toBe(false);
    expect(awaitingRenewal([pmt("a", "TAP", "2026-08-01", "2026-11-01")], TODAY)).toBe(false);
  });

  it("leaves out a prescription renewed with the same mode and series", () => {
    expect(awaitingRenewal([pmt("a", "TAP", "2026-08-01", "2026-11-15"), pmt("b", "TAP", "2026-11-16", "2027-02-15")], TODAY)).toBe(false);
  });

  it("keeps it when the later prescription has another mode or serves another series of care", () => {
    // A TAP PMT ending in 5 days and an ambulance PMT starting later: not a renewal (as the badge says).
    expect(awaitingRenewal([pmt("a", "TAP", "2026-08-01", "2026-11-15"), pmt("b", "AMBULANCE", "2026-11-20", "2027-02-15")], TODAY)).toBe(true);
    // Radiotherapy beside dialysis: the later TAP PMT belongs to another facility's series.
    expect(
      awaitingRenewal([pmt("a", "TAP", "2026-08-01", "2026-11-15", ["dialyse"]), pmt("b", "TAP", "2026-11-16", "2027-02-15", ["radio"])], TODAY),
    ).toBe(true);
  });

  it("follows the prescription the list shows: a longer one valid today hides nothing to renew", () => {
    expect(awaitingRenewal([pmt("a", "TAP", "2026-08-01", "2026-11-15"), pmt("b", "AMBULANCE", "2026-10-01", "2027-03-01")], TODAY)).toBe(false);
  });
});
