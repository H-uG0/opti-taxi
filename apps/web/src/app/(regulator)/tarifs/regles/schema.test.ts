import { describe, expect, it } from "vitest";
import { fieldErrorsFromZod } from "@/lib/forms";
import { fromIsoDate } from "@/lib/time";
import { areaFormValues, areaSchema, billingSettingsSchema, certificationSchema, holidaySchema } from "./schema";

function errorsOf(schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, input: Record<string, string>) {
  const result = schema.safeParse(input);
  return result.success ? {} : fieldErrorsFromZod(result.error as never).fieldErrors;
}

describe("certification periods", () => {
  it("stores dates as @db.Date, an open end as null", () => {
    expect(certificationSchema.parse({ validFrom: "01/01/2025", validTo: "", note: "" })).toEqual({
      validFrom: fromIsoDate("2025-01-01"),
      validTo: null,
      note: null,
    });
    expect(errorsOf(certificationSchema, { validFrom: "2025-06-01", validTo: "2025-01-01" }).validTo).toMatch(/postérieure/);
  });
});

describe("billing settings", () => {
  const valid = { hqDepartment: "13", hqCity: "Marseille", emptyLegRule: "DEPOT", surchargeOrder: "MULTIPLICATIVE", sharedPatientCount: "DISTINCT" };
  it("accepts a head office and the readings of the conventions", () => {
    expect(billingSettingsSchema.parse(valid)).toEqual(valid);
    expect(billingSettingsSchema.parse({ ...valid, hqDepartment: "", hqCity: "" })).toMatchObject({ hqDepartment: null, hqCity: null });
  });
  it("wants both parts of the head office, and known rules", () => {
    expect(errorsOf(billingSettingsSchema, { ...valid, hqCity: "" }).hqCity).toMatch(/département et la commune/);
    expect(errorsOf(billingSettingsSchema, { ...valid, hqDepartment: "1234" }).hqDepartment).toMatch(/département/);
    expect(errorsOf(billingSettingsSchema, { ...valid, emptyLegRule: "ALWAYS" }).emptyLegRule).toBeDefined();
  });
});

describe("holidays", () => {
  it("needs a date and a label", () => {
    expect(holidaySchema.parse({ date: "2026-11-11", label: "Armistice 1918" })).toEqual({ date: fromIsoDate("2026-11-11"), label: "Armistice 1918" });
    expect(errorsOf(holidaySchema, { date: "", label: "" })).toMatchObject({ date: expect.any(String), label: expect.any(String) });
  });
});

describe("tariff areas", () => {
  const valid = {
    kind: "AGGLOMERATION",
    name: "Agglomération d'Avignon",
    department: "84",
    communes: "Sorgues\nLes Angles (30)\nsorgues",
    rule: "TO_HUB",
    hubCommune: "Avignon",
    validFrom: "",
    validTo: "",
    verification: "OFFICIAL",
    sourceUrl: "https://www.ameli.fr/x",
    notes: "",
  };
  it("stores the communes as a list, without duplicates", () => {
    expect(areaSchema.parse(valid)).toMatchObject({ communes: ["Sorgues", "Les Angles (30)"], hubCommune: "Avignon", validFrom: null });
  });
  it("needs communes, and a centre for the «\u202fvers la commune centre\u202f» rule", () => {
    expect(errorsOf(areaSchema, { ...valid, communes: " \n " }).communes).toMatch(/commune/);
    expect(errorsOf(areaSchema, { ...valid, hubCommune: "" }).hubCommune).toMatch(/commune centre/);
    expect(areaSchema.parse({ ...valid, rule: "ANY_END" }).hubCommune).toBeNull();
  });
  it("gives back the values of a saved area", () => {
    const parsed = areaSchema.parse(valid);
    expect(areaFormValues(parsed)).toMatchObject({ communes: "Sorgues\nLes Angles (30)", rule: "TO_HUB", validFrom: "" });
  });
});
