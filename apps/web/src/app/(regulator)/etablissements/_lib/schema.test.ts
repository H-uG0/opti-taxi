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
    });
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
