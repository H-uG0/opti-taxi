import { describe, expect, it } from "vitest";
import { crewQualificationErrors, qualificationRequirement, qualificationScope } from "./_lib/crew";
import { departmentField, departmentLabel, normalizeDepartment } from "./_lib/departments";
import { fieldErrorsFromZod } from "@/lib/forms";
import { normalizeRegistration, vehicleFormValues, vehicleSchema } from "./schema";

const valid = {
  label: "Taxi 1 Marseille",
  registration: "ab 123 cd",
  type: "TAXI",
  capacity: "2",
  depotId: "depot_marseille",
  department: "13",
  costPerKm: "0,32",
  defaultDriverId: "",
  defaultCrewMateId: "",
};

/** Field errors exactly as the form displays them (first issue per field). */
function errorsOf(input: Record<string, string>) {
  const result = vehicleSchema.safeParse(input);
  return result.success ? {} : fieldErrorsFromZod(result.error).fieldErrors;
}

describe("vehicleSchema", () => {
  it("normalises a valid taxi", () => {
    const vehicle = vehicleSchema.parse(valid);
    expect(vehicle).toMatchObject({
      registration: "AB-123-CD",
      type: "TAXI",
      capacity: 2,
      depotId: "depot_marseille",
      department: "13",
      costPerKm: 0.32,
      energy: null,
      defaultDriverId: null,
      defaultCrewMateId: null,
    });
  });

  it("forces an ambulance to 1 patient", () => {
    expect(vehicleSchema.parse({ ...valid, type: "AMBULANCE", capacity: "3" }).capacity).toBe(1);
    expect(vehicleSchema.parse({ ...valid, type: "AMBULANCE", capacity: "" }).capacity).toBe(1);
  });

  it("defaults taxis and VSL to V's rule and caps them at 3", () => {
    expect(vehicleSchema.parse({ ...valid, type: "VSL", capacity: "" }).capacity).toBe(2);
    expect(vehicleSchema.parse({ ...valid, type: "VSL", capacity: "3" }).capacity).toBe(3);
    expect(errorsOf({ ...valid, capacity: "4" }).capacity).toMatch(/Entre 1 et 3/);
    expect(errorsOf({ ...valid, capacity: "0" }).capacity).toMatch(/Entre 1 et 3/);
  });

  it("validates the department", () => {
    expect(vehicleSchema.parse({ ...valid, department: "4" }).department).toBe("04");
    expect(vehicleSchema.parse({ ...valid, department: "2a" }).department).toBe("2A");
    expect(errorsOf({ ...valid, department: "*" }).department).toBeDefined();
    expect(errorsOf({ ...valid, department: "1234" }).department).toBeDefined();
  });

  it("rejects malformed registrations", () => {
    expect(errorsOf({ ...valid, registration: "AB/123" }).registration).toMatch(/Lettres, chiffres/);
    expect(errorsOf({ ...valid, registration: "  " }).registration).toBe("Champ obligatoire.");
  });

  it("keeps the energy, blank meaning not filled in", () => {
    expect(vehicleSchema.parse({ ...valid, energy: "ELECTRIC" }).energy).toBe("ELECTRIC");
    expect(vehicleSchema.parse({ ...valid, energy: "" }).energy).toBeNull();
    expect(errorsOf({ ...valid, energy: "STEAM" }).energy).toBe("Énergie inconnue.");
  });

  it("requires a depot", () => {
    expect(errorsOf({ ...valid, depotId: "" }).depotId).toBe("Choisissez un dépôt.");
    expect(errorsOf({ ...valid, depotId: "../x" }).depotId).toBe("Identifiant invalide.");
  });

  it("requires a crew mate different from the driver, only for ambulances", () => {
    expect(
      errorsOf({ ...valid, type: "AMBULANCE", defaultDriverId: "drv1", defaultCrewMateId: "drv1" }).defaultCrewMateId,
    ).toMatch(/autre personne/);
    const ambulance = vehicleSchema.parse({ ...valid, type: "AMBULANCE", defaultDriverId: "drv1", defaultCrewMateId: "drv2" });
    expect(ambulance.defaultCrewMateId).toBe("drv2");
    const taxi = vehicleSchema.parse({ ...valid, defaultDriverId: "drv1", defaultCrewMateId: "drv2" });
    expect(taxi.defaultCrewMateId).toBeNull();
  });

  it("round-trips a record through the form values", () => {
    const parsed = vehicleSchema.parse(valid);
    const again = vehicleSchema.parse(vehicleFormValues({ ...parsed }));
    expect(again).toEqual(parsed);
  });
});

describe("normalizeRegistration", () => {
  it("uppercases and uses single dashes", () => {
    expect(normalizeRegistration(" ab  123_cd ")).toBe("AB-123-CD");
    expect(normalizeRegistration("ab--123-cd-")).toBe("AB-123-CD");
  });
});

describe("departments", () => {
  it("normalises and labels codes", () => {
    expect(normalizeDepartment(" 5 ")).toBe("05");
    expect(departmentLabel("13")).toBe("13 · Bouches-du-Rhône");
    expect(departmentLabel("*")).toBe("Toutes zones");
    expect(departmentField({ allowAllZones: true }).parse("*")).toBe("*");
  });
});

describe("crew qualifications", () => {
  const taxiDriver = { firstName: "Marc", lastName: "Durand", qualifications: ["TAXI_CARD"] as const };
  const auxiliary = { firstName: "Léa", lastName: "Martin", qualifications: ["AUXILIARY"] as const };
  const dea = { firstName: "Paul", lastName: "Roux", qualifications: ["DEA"] as const };

  it("accepts qualified crews", () => {
    expect(crewQualificationErrors("TAXI", taxiDriver, null)).toEqual({});
    expect(crewQualificationErrors("VSL", auxiliary, null)).toEqual({});
    expect(crewQualificationErrors("AMBULANCE", dea, auxiliary)).toEqual({});
    expect(crewQualificationErrors("AMBULANCE", null, null)).toEqual({});
  });

  it("blocks a driver or crew mate without the required qualification", () => {
    expect(crewQualificationErrors("TAXI", auxiliary, null).defaultDriverId).toBe(
      "Léa Martin n'a pas la qualification requise pour conduire un taxi (Carte professionnelle taxi).",
    );
    expect(crewQualificationErrors("AMBULANCE", auxiliary, dea).defaultDriverId).toMatch(/une ambulance \(Ambulancier DE\)/);
    expect(crewQualificationErrors("AMBULANCE", dea, taxiDriver).defaultCrewMateId).toBe(
      "Marc Durand n'a pas la qualification requise pour être équipier d'ambulance (Auxiliaire ambulancier ou Ambulancier DE).",
    );
  });

  it("describes requirements and scopes in French", () => {
    expect(qualificationRequirement(["AUXILIARY", "DEA"])).toBe("Auxiliaire ambulancier ou Ambulancier DE");
    expect(qualificationScope("DEA")).toBe("Conduite : VSL, ambulance · Équipier : ambulance");
    expect(qualificationScope("TAXI_CARD")).toBe("Conduite : taxi");
  });
});
