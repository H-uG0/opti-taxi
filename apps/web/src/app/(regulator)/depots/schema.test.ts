import { describe, expect, it } from "vitest";
import { fieldErrorsFromZod } from "@/lib/forms";
import { depotFormValues, depotMoved, depotSchema, movedDepotNotice, parseCoordinatePair } from "./schema";

const valid = {
  name: "Marseille",
  address: "27 rue des Cigales, 13012 Marseille",
  lat: "43,2965",
  lng: "5.3698",
  notes: "",
};

/** Field errors exactly as the form displays them (first issue per field). */
function errorsOf(input: Record<string, string>) {
  const result = depotSchema.safeParse(input);
  return result.success ? {} : fieldErrorsFromZod(result.error).fieldErrors;
}

describe("depotSchema", () => {
  it("normalises a valid depot", () => {
    expect(depotSchema.parse(valid)).toEqual({
      name: "Marseille",
      address: "27 rue des Cigales, 13012 Marseille",
      lat: 43.2965,
      lng: 5.3698,
      notes: null,
    });
  });

  it("requires a name and an address", () => {
    expect(errorsOf({ ...valid, name: "  " }).name).toBe("Champ obligatoire.");
    expect(errorsOf({ ...valid, address: "" }).address).toBe("Champ obligatoire.");
  });

  it("detects swapped or foreign coordinates", () => {
    expect(errorsOf({ ...valid, lat: "5.3698", lng: "43.2965" }).lat).toMatch(/inversées/);
    expect(errorsOf({ ...valid, lat: "40.71", lng: "-74.0" }).lat).toMatch(/hors de France/);
    expect(errorsOf({ ...valid, lat: "abc" }).lat).toMatch(/Nombre attendu/);
  });

  it("round-trips a record through the form values", () => {
    const parsed = depotSchema.parse({ ...valid, notes: "Portail B" });
    expect(depotSchema.parse(depotFormValues(parsed))).toEqual(parsed);
  });
});

describe("parseCoordinatePair", () => {
  it("splits a pair pasted from a map", () => {
    expect(parseCoordinatePair("43.29651, 5.36978")).toEqual({ lat: "43.29651", lng: "5.36978" });
    expect(parseCoordinatePair("43,2965\u202f; 5,3698")).toEqual({ lat: "43,2965", lng: "5,3698" });
    expect(parseCoordinatePair("43.2965 5.3698")).toEqual({ lat: "43.2965", lng: "5.3698" });
  });

  it("ignores a single number or text", () => {
    expect(parseCoordinatePair("43,2965")).toBeNull();
    expect(parseCoordinatePair("Marseille")).toBeNull();
    expect(parseCoordinatePair("143.2, 5.3")).toBeNull();
  });
});

describe("a moved depot", () => {
  it("is detected on its coordinates only", () => {
    expect(depotMoved({ lat: 43.3, lng: 5.37 }, { lat: 43.3, lng: 5.37 })).toBe(false);
    expect(depotMoved({ lat: 43.3, lng: 5.37 }, { lat: 43.31, lng: 5.37 })).toBe(true);
  });

  it("lists the upcoming routes that still start from the old place", () => {
    expect(movedDepotNotice([])).toBeNull();
    expect(
      movedDepotNotice([
        { date: "2026-11-09", status: "PROPOSED" },
        { date: "2026-11-10", status: "VALIDATED" },
      ]),
    ).toBe(
      "Dépôt enregistré. 2 tournées à venir (09/11/2026, 10/11/2026) partent encore de l'ancienne position du dépôt\u00a0: " +
        "relancez l'optimisation de ces jours depuis le planning.",
    );
    expect(movedDepotNotice([{ date: "2026-11-09", status: "PROPOSED" }])).toMatch(/1 tournée à venir \(09\/11\/2026\) part encore .* de ce jour/);
  });
});
