/**
 * Address helpers shared by the address form fields (client), the server
 * actions and the tests. Pure and dependency-free: no zod, no server import.
 */

export const ADDRESS_FIELD_NAMES = ["address", "postalCode", "city", "lat", "lng"] as const;
export type AddressFieldName = (typeof ADDRESS_FIELD_NAMES)[number];

/** Raw (string) values of the address inputs, as typed in the form. */
export type AddressFormValues = Record<AddressFieldName, string>;

export type AddressFieldErrors = Partial<Record<AddressFieldName, string | string[] | undefined>>;

/**
 * Coordinates must fall in metropolitan France (Corsica included). This catches
 * the most common typing mistake, swapped latitude and longitude, which would
 * otherwise send the optimizer hundreds of kilometres away.
 */
export const LAT_RANGE = { min: 41, max: 51.5 } as const;
export const LNG_RANGE = { min: -5.5, max: 10 } as const;

/** BAN score under which a geocoding match must be checked by hand. */
export const LOW_GEOCODE_SCORE = 0.5;

/** Max length of the address text sent to the geocoder. */
export const GEOCODE_QUERY_MAX = 200;

export const EMPTY_ADDRESS: AddressFormValues = { address: "", postalCode: "", city: "", lat: "", lng: "" };

/** Reads the address inputs of a submitted form as strings. */
export function readAddressForm(formData: FormData): AddressFormValues {
  const read = (key: AddressFieldName) => {
    const value = formData.get(key);
    return typeof value === "string" ? value : "";
  };
  return {
    address: read("address"),
    postalCode: read("postalCode"),
    city: read("city"),
    lat: read("lat"),
    lng: read("lng"),
  };
}

/** Coordinates printed with at most 6 decimals (~10 cm). */
export function formatCoordinate(value: number): string {
  return Number(value.toFixed(6)).toString();
}

/** Form values of a stored place. */
export function addressFormValues(place: {
  address: string;
  postalCode: string;
  city: string;
  lat: number;
  lng: number;
}): AddressFormValues {
  return {
    address: place.address,
    postalCode: place.postalCode,
    city: place.city,
    lat: formatCoordinate(place.lat),
    lng: formatCoordinate(place.lng),
  };
}

/** Text sent to the geocoder: the address only, never a person's name. */
export function buildGeocodeQuery(values: Pick<AddressFormValues, "address" | "postalCode" | "city">): string {
  return [values.address, values.postalCode, values.city]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, GEOCODE_QUERY_MAX);
}

/** One geocoding suggestion shown under the address fields. */
export type GeocodeSuggestion = {
  label: string;
  address: string;
  postalCode: string;
  city: string;
  lat: number;
  lng: number;
  /** BAN confidence, 0..1. */
  score: number;
};

export type GeocodeOutcome =
  | { status: "ok"; results: GeocodeSuggestion[] }
  | { status: "disabled" }
  | { status: "invalid"; message: string }
  | { status: "error"; message: string };
