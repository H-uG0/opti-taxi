import { describe, expect, it } from "vitest";
import { isFiltered, parsePatientFilter, patientOrderBy, patientParams, patientWhere, searchTerms } from "./list-filter";

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
    expect(patientWhere(parse("pmt=a-renouveler"), TODAY).AND).toEqual([
      { prescriptions: { some: { validFrom: { lte: today }, validTo: { gte: today, lte: limit } } } },
      { prescriptions: { none: { validTo: { gt: limit } } } },
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
