/**
 * Links that hand a stop over to the phone: turn-by-turn navigation apps and
 * phone calls. Pure functions (unit-tested). Only coordinates are passed to the
 * navigation apps: no patient name or note leaves the application.
 */

export type NavigationLinks = {
  /** Google Maps directions to the stop (app on Android / iOS, web elsewhere). */
  googleMaps: string;
  /** Waze, navigation started at once. */
  waze: string;
  /** geo: URI, lets Android pick any installed navigation app. */
  geo: string;
};

/** Coordinates with 6 decimals (about 10 cm), trailing zeros dropped, never in exponent notation. */
function formatCoordinate(value: number): string {
  const fixed = value.toFixed(6);
  const trimmed = fixed.replace(/\.?0+$/, "");
  return trimmed === "-0" || trimmed === "" ? "0" : trimmed;
}

export function isValidPoint(point: { lat: number; lng: number }): boolean {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    Math.abs(point.lat) <= 90 &&
    Math.abs(point.lng) <= 180
  );
}

/** Navigation links to a point, or null when its coordinates are unusable. */
export function navigationLinks(point: { lat: number; lng: number }): NavigationLinks | null {
  if (!isValidPoint(point)) return null;
  const latLng = `${formatCoordinate(point.lat)},${formatCoordinate(point.lng)}`;
  return {
    googleMaps: `https://www.google.com/maps/dir/?api=1&destination=${latLng}&travelmode=driving`,
    waze: `https://waze.com/ul?ll=${latLng}&navigate=yes`,
    geo: `geo:${latLng}?q=${latLng}`,
  };
}

/**
 * tel: link of a phone number typed by hand ("06 12 34 56 78", "+33 6 12…",
 * "04.91.00.00.00"): digits only, leading "+" kept. Null when there is no
 * usable number.
 */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 3) return null;
  return `tel:${trimmed.startsWith("+") ? "+" : ""}${digits}`;
}

/** Regulation phone number as the roadmap shows it and dials it. */
export type RegulatorContact = { number: string; href: string };

/** Contact of the regulation (Paramètres), or null when no usable number is set. */
export function regulatorContact(phone: string | null | undefined): RegulatorContact | null {
  const href = telHref(phone);
  return phone && href ? { number: phone.trim(), href } : null;
}
