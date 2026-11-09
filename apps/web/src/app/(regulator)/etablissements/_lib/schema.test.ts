import { describe, expect, it } from "vitest";
import { parseFacilityForm } from "./schema";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.set(key, value);
  return fd;
}

const facility = {
  name: "Centre de dialyse de Gap",
  type: "DIALYSIS",
  address: "1 place Auguste Muret",
  postalCode: "05000",
  city: "Gap",
  lat: "44.5594",
  lng: "6.0786",
  phone: "04 92 40 61 61",
  notes: "",
  extraServiceMin: "",
};

describe("parseFacilityForm", () => {
  it("parses a valid facility", () => {
    const result = parseFacilityForm(form(facility));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      name: "Centre de dialyse de Gap",
      type: "DIALYSIS",
      address: "1 place Auguste Muret",
      postalCode: "05000",
      city: "Gap",
      lat: 44.5594,
      lng: 6.0786,
      phone: "04 92 40 61 61",
      notes: null,
      extraServiceMin: 0,
    });
  });

  it("reads the minutes added to the stop at the facility", () => {
    const parsed = parseFacilityForm(form({ ...facility, extraServiceMin: "10" }));
    expect(parsed.success && parsed.data.extraServiceMin).toBe(10);
    expect(parseFacilityForm(form({ ...facility, extraServiceMin: " 15 " })).success).toBe(true);
    const cases = [["2,5", "Nombre entier"], ["61", "60 min au plus"], ["-1", "0 min au moins"], ["dix", "Nombre"], ["0x3C", "Nombre"], ["1e1", "Nombre"]] as const;
    for (const [typed, message] of cases) {
      const result = parseFacilityForm(form({ ...facility, extraServiceMin: typed }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.state.fieldErrors.extraServiceMin?.[0]).toContain(message);
    }
  });

  it("reports missing name, unknown type and bad address fields", () => {
    const result = parseFacilityForm(form({ ...facility, name: " ", type: "SPA", postalCode: "5000", lng: "" }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.state.fieldErrors.name?.[0]).toBe("Nom obligatoire");
    expect(result.state.fieldErrors.type?.[0]).toBe("Choisissez un type d'établissement");
    expect(result.state.fieldErrors.postalCode?.[0]).toBe("Code postal : 5 chiffres");
    expect(result.state.fieldErrors.lng?.[0]).toBe("Longitude obligatoire");
    expect(result.state.values?.name).toBe(" ");
  });

  it("keeps the phone optional", () => {
    const result = parseFacilityForm(form({ ...facility, phone: "" }));
    expect(result.success && result.data.phone).toBeNull();
  });
});
