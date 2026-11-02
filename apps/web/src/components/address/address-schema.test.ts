import { describe, expect, it } from "vitest";
import { addressSchema, geocodeQuerySchema } from "./address-schema";
import { addressFormValues, buildGeocodeQuery, formatCoordinate, readAddressForm } from "./address-utils";

const valid = { address: "12 rue de la République", postalCode: "13001", city: "Marseille", lat: "43.2965", lng: "5.3698" };

function errorsOf(input: Record<string, string>) {
  const result = addressSchema.safeParse(input);
  if (result.success) return {};
  const out: Record<string, string> = {};
  for (const issue of result.error.issues) out[String(issue.path[0])] ??= issue.message;
  return out;
}

describe("addressSchema", () => {
  it("parses a complete address and converts coordinates to numbers", () => {
    expect(addressSchema.parse(valid)).toEqual({
      address: "12 rue de la République",
      postalCode: "13001",
      city: "Marseille",
      lat: 43.2965,
      lng: 5.3698,
    });
  });

  it("accepts French decimal commas and trims", () => {
    const parsed = addressSchema.parse({ ...valid, lat: " 44,5594 ", lng: "6,0786", city: "  Gap " });
    expect(parsed.lat).toBeCloseTo(44.5594);
    expect(parsed.lng).toBeCloseTo(6.0786);
    expect(parsed.city).toBe("Gap");
  });

  it("requires address, city and coordinates", () => {
    const errors = errorsOf({ address: " ", postalCode: "05000", city: "", lat: "", lng: "" });
    expect(errors.address).toBe("Adresse obligatoire");
    expect(errors.city).toBe("Ville obligatoire");
    expect(errors.lat).toBe("Latitude obligatoire");
    expect(errors.lng).toBe("Longitude obligatoire");
  });

  it("requires a 5-digit postal code", () => {
    expect(errorsOf({ ...valid, postalCode: "1300" }).postalCode).toBe("Code postal : 5 chiffres");
    expect(errorsOf({ ...valid, postalCode: "13 001" }).postalCode).toBe("Code postal : 5 chiffres");
    expect(errorsOf({ ...valid, postalCode: "2A004" }).postalCode).toBe("Code postal : 5 chiffres");
  });

  it("rejects non-numeric and out-of-France coordinates (e.g. swapped lat/lng)", () => {
    expect(errorsOf({ ...valid, lat: "abc" }).lat).toMatch(/nombre décimal attendu/);
    const swapped = errorsOf({ ...valid, lat: "5.3698", lng: "43.2965" });
    expect(swapped.lat).toMatch(/hors de France métropolitaine/);
    expect(swapped.lng).toMatch(/hors de France métropolitaine/);
    expect(errorsOf({ ...valid, lat: "91" }).lat).toMatch(/hors de France/);
  });
});

describe("address helpers", () => {
  it("reads the address inputs of a form", () => {
    const fd = new FormData();
    fd.set("address", "1 place Grenette");
    fd.set("postalCode", "38000");
    fd.set("city", "Grenoble");
    fd.set("lat", "45.19");
    expect(readAddressForm(fd)).toEqual({
      address: "1 place Grenette",
      postalCode: "38000",
      city: "Grenoble",
      lat: "45.19",
      lng: "",
    });
  });

  it("prints stored coordinates with at most 6 decimals", () => {
    expect(formatCoordinate(43.29650000001)).toBe("43.2965");
    expect(formatCoordinate(5.123456789)).toBe("5.123457");
    expect(addressFormValues({ address: "a", postalCode: "04100", city: "Manosque", lat: 43.83, lng: 5.78 })).toEqual({
      address: "a",
      postalCode: "04100",
      city: "Manosque",
      lat: "43.83",
      lng: "5.78",
    });
  });

  it("builds the geocoder query from the address only", () => {
    expect(buildGeocodeQuery({ address: " 12  rue Droite ", postalCode: "04200", city: "Sisteron" })).toBe(
      "12 rue Droite 04200 Sisteron",
    );
    expect(buildGeocodeQuery({ address: "", postalCode: "", city: "Gap" })).toBe("Gap");
    expect(buildGeocodeQuery({ address: "x".repeat(300), postalCode: "", city: "" })).toHaveLength(200);
  });

  it("bounds the geocoder query length", () => {
    expect(geocodeQuerySchema.safeParse("ab").success).toBe(false);
    expect(geocodeQuerySchema.safeParse("x".repeat(201)).success).toBe(false);
    expect(geocodeQuerySchema.safeParse(42).success).toBe(false);
    expect(geocodeQuerySchema.parse("  Gap  ")).toBe("Gap");
  });
});
