/**
 * The driver app's display (FLD-04): « Auto » follows the phone's light or dark setting, « Jour » and « Nuit » force
 * one (a white screen dazzles at 6 am in winter). Remembered on the phone in a cookie the server reads, so the page is
 * drawn in the right theme from its first frame (no white flash at night). Not personal data: no consent needed.
 * Pure module.
 */

export type DriverTheme = "auto" | "day" | "night";

export const DRIVER_THEMES: readonly DriverTheme[] = ["auto", "day", "night"];

export const DRIVER_THEME_LABELS: Record<DriverTheme, string> = { auto: "Auto", day: "Jour", night: "Nuit" };

export const THEME_COOKIE = "opti-theme";

/** The theme of a cookie's value (« auto » for anything else). */
export function parseDriverTheme(value: string | null | undefined): DriverTheme {
  return value === "day" || value === "night" ? value : "auto";
}

/** The cookie that remembers it a year, for the driver app only. */
export function themeCookie(theme: DriverTheme): string {
  return `${THEME_COOKIE}=${theme}; Path=/chauffeur; Max-Age=${365 * 24 * 3600}; SameSite=Lax`;
}
