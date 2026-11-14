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
      openOnHolidays: false,
      openingHours: [],
      earliestArrivalMinute: null,
    });
  });

  it("reads the reception hours of each weekday and the earliest arrival (PAT-04)", () => {
    const parsed = parseFacilityForm(
      form({ ...facility, hoursOpen1: "07:00", hoursClose1: "19:00", hoursOpen6: "8h", hoursClose6: "12:00", earliestArrival: "06:45" }),
    );
    expect(parsed.success && parsed.data.openingHours).toEqual([
      { weekday: 1, openMinute: 420, closeMinute: 1140 },
      { weekday: 6, openMinute: 480, closeMinute: 720 },
    ]);
    expect(parsed.success && parsed.data.earliestArrivalMinute).toBe(405);
  });

  it("refuses a day with one bound only, a closing before the opening, and a bad time", () => {
    const parsed = parseFacilityForm(
      form({ ...facility, hoursOpen1: "07:00", hoursClose2: "19:00", hoursOpen3: "19:00", hoursClose3: "07:00" }),
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.state.fieldErrors).toMatchObject({
      hoursClose1: "Saisissez l'ouverture et la fermeture",
      hoursOpen2: "Saisissez l'ouverture et la fermeture",
      hoursClose3: "La fermeture doit suivre l'ouverture",
    });
    const bad = parseFacilityForm(form({ ...facility, earliestArrival: "25:00" }));
    expect(!bad.success && bad.state.fieldErrors.earliestArrival).toMatch(/Heure invalide/);
  });

  it("reads « ouvert les jours fériés » (PAT-03), and echoes it after a refusal", () => {
    const parsed = parseFacilityForm(form({ ...facility, openOnHolidays: "on" }));
    expect(parsed.success && parsed.data.openOnHolidays).toBe(true);
    const refused = parseFacilityForm(form({ ...facility, name: "", openOnHolidays: "on" }));
    expect(!refused.success && refused.state.values?.openOnHolidays).toBe("on");
  });

  it("reads the minutes added to the stop at the facility", () => {
    const parsed = parseFacilityForm(form({ ...facility, extraServiceMin: "10" }));
    expect(parsed.success && parsed.data.extraServiceMin).toBe(10);
    expect(parseFacilityForm(form({ ...facility, extraServiceMin: " 15 " })).success).toBe(true);
    const cases = [["2,5", "Nombre entier"], ["61", "60\u00a0min au plus"], ["-1", "0\u00a0min au moins"], ["dix", "Nombre"], ["0x3C", "Nombre"], ["1e1", "Nombre"]] as const;
    for (const [typed, message] of cases) {
      const result = parseFacilityForm(form({ ...facility, extraServiceMin: typed }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.state.fieldErrors.extraServiceMin).toContain(message);
    }
  });

  it("reports missing name, unknown type and bad address fields", () => {
    const result = parseFacilityForm(form({ ...facility, name: " ", type: "SPA", postalCode: "5000", lng: "" }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.state.fieldErrors.name).toBe("Nom obligatoire");
    expect(result.state.fieldErrors.type).toBe("Choisissez un type d'établissement");
    expect(result.state.fieldErrors.postalCode).toBe("Code postal\u00a0: 5 chiffres");
    expect(result.state.fieldErrors.lng).toBe("Longitude obligatoire");
    expect(result.state.values?.name).toBe(" ");
  });

  it("keeps the phone optional", () => {
    const result = parseFacilityForm(form({ ...facility, phone: "" }));
    expect(result.success && result.data.phone).toBeNull();
  });
});
