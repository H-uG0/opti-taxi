import { describe, expect, it } from "vitest";
import {
  filterHref,
  formQuery,
  idParam,
  matchesWords,
  normalizeSearch,
  pageItems,
  pageOf,
  phoneDigits,
  pickParam,
  readParam,
} from "./list-filters";

describe("list filters in the URL", () => {
  it("reads the first value of a parameter, trimmed and capped", () => {
    expect(readParam({ q: ["  Gap ", "Aix"] }, "q")).toBe("Gap");
    expect(readParam(new URLSearchParams("q=x"), "q")).toBe("x");
    expect(readParam({}, "q")).toBe("");
    expect(readParam({ q: "a".repeat(300) }, "q", 10)).toHaveLength(10);
  });

  it("keeps only the allowed values and id-like parameters", () => {
    expect(pickParam({ type: "TAXI" }, "type", ["TAXI", "VSL"])).toBe("TAXI");
    expect(pickParam({ type: "BUS" }, "type", ["TAXI", "VSL"])).toBeNull();
    expect(idParam({ depot: "clx_12-ab" }, "depot")).toBe("clx_12-ab");
    expect(idParam({ depot: "a b" }, "depot")).toBeNull();
  });

  it("builds a short address without empty values", () => {
    expect(filterHref("/vehicules", { q: "", depot: "d1", type: null, page: 2 })).toBe("/vehicules?depot=d1&page=2");
    expect(filterHref("/vehicules", {})).toBe("/vehicules");
  });

  it("leaves the empty fields and those at their default out of a form's query", () => {
    const entries: [string, string][] = [
      ["q", " dupont "],
      ["statut", "actifs"],
      ["depot", ""],
      ["alerte", "a"],
      ["alerte", "b"],
    ];
    expect(formQuery(entries, { statut: "actifs" })).toBe("q=dupont&alerte=a&alerte=b");
  });
});

describe("search without accents", () => {
  it("normalizes accents, ligatures, case and spaces", () => {
    expect(normalizeSearch("  Hélène   ŒUVRAY ")).toBe("helene oeuvray");
    expect(normalizeSearch("Laragne-Montéglin")).toBe("laragne-monteglin");
  });

  it("needs every word in one of the texts", () => {
    expect(matchesWords("helene gap", ["Hélène Martin", "Gap"])).toBe(true);
    expect(matchesWords("helene aix", ["Hélène Martin", "Gap"])).toBe(false);
    expect(matchesWords("  ", ["x"])).toBe(true);
  });

  it("reads a phone number as its national digits", () => {
    expect(phoneDigits("06 12 34 56 78")).toBe("0612345678");
    expect(phoneDigits("+33 6 12 34 56 78")).toBe("0612345678");
    expect(phoneDigits("0033 6 12 34 56 78")).toBe("0612345678");
    expect(phoneDigits("04.92.51.00.00")).toBe("0492510000");
    expect(phoneDigits("33 6 12 34 56 78")).toBe("0612345678");
  });

  // The patients' search key is written by a database trigger (migration patient_search: unaccent, phone digits);
  // the search field reads it with normalizeSearch and phoneDigits. Keys recorded from that trigger on
  // PostgreSQL 17 (INSERT … RETURNING "searchText"): both sides must give the same words.
  it.each([
    [["Łukasz-Œuvray", "Søren", "Gap", "05000", "+33 6 12 34 56 78"], "lukasz-oeuvray soren gap 05000 0612345678"],
    [["N’Diaye", "Lætitia", "Sisteron", "04200", "0033 4.92.51.00.00"], "n'diaye laetitia sisteron 04200 0492510000"],
    [["Þórsson", "Đorđe", "Marseille", "13006", "33612345678"], "thorsson dorde marseille 13006 0612345678"],
    [["STRAẞE", "Hélène", "Manosque", "04100", "06 12 34 56 78"], "strasse helene manosque 04100 0612345678"],
    [["Ħalil", "Ðan", "Aix-en-Provence", "13100", "(04) 92 51"], "halil dan aix-en-provence 13100 049251"],
    [["Ångström", "Ŀuís", "Saint-Égrève", "38000", "+41 22 345 67 89"], "angstrom luis saint-egreve 38000 41223456789"],
    [["ﬁlou", "Ĳsbrand", "L’Argentière-la-Bessée", "05000", null], "filou ijsbrand l'argentiere-la-bessee 05000"],
  ] as const)("searches %j as the database key %j", ([lastName, firstName, city, postalCode, phone], key) => {
    const digits = phone ? phoneDigits(phone) : "";
    expect([normalizeSearch(`${lastName} ${firstName} ${city} ${postalCode}`), digits].filter(Boolean).join(" ")).toBe(key);
  });
});

describe("pages of a long list", () => {
  it("keeps the page within the pages that exist", () => {
    expect(pageOf({ page: "3" }, 250, 100)).toEqual({ page: 3, pageCount: 3, skip: 200 });
    expect(pageOf({ page: "9" }, 250, 100)).toEqual({ page: 3, pageCount: 3, skip: 200 });
    expect(pageOf({ page: "-1" }, 250, 100)).toEqual({ page: 1, pageCount: 3, skip: 0 });
    expect(pageOf({ page: "abc" }, 0, 100)).toEqual({ page: 1, pageCount: 1, skip: 0 });
  });

  it("shows the first, last and neighbouring pages, with gaps", () => {
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(1, 5)).toEqual([1, 2, "…", 5]);
    expect(pageItems(5, 20)).toEqual([1, "…", 4, 5, 6, "…", 20]);
    // A gap of one page shows the page itself.
    expect(pageItems(4, 20)).toEqual([1, 2, 3, 4, 5, "…", 20]);
    expect(pageItems(20, 20)).toEqual([1, "…", 19, 20]);
  });
});
