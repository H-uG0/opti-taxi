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
