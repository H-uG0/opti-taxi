/**
 * Vehicle colors. The server gives each vehicle a shade of its type color
 * (vehicle panel, stored views); the timeline and the map color the vehicles
 * shown with a categorical palette instead (displayColors). Pure: hex strings
 * in, hex strings out.
 */

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? [...clean].map((c) => c + c).join("") : clean;
  const value = Number.parseInt(full.slice(0, 6), 16);
  if (Number.isNaN(value)) return [100, 116, 139];
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => clampByte(c).toString(16).padStart(2, "0")).join("")}`;
}

/** Mix toward black (amount > 0) or white (amount < 0); |amount| in [0, 1]. */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const target = amount > 0 ? 0 : 255;
  const t = Math.min(1, Math.abs(amount));
  return rgbToHex([r + (target - r) * t, g + (target - g) * t, b + (target - b) * t]);
}

/** Alternating darker / lighter steps, kept readable on a light map. */
const SHADE_STEPS = [0, 0.32, -0.3, 0.52, 0.16, -0.15, 0.42, -0.42];

/** Color of the index-th vehicle of a type. */
export function vehicleShade(baseHex: string, index: number): string {
  const step = SHADE_STEPS[((index % SHADE_STEPS.length) + SHADE_STEPS.length) % SHADE_STEPS.length] ?? 0;
  return step === 0 ? baseHex.toLowerCase() : shade(baseHex, step);
}

/**
 * Colors of the vehicles shown on the timeline and the map (UX-05): one hue
 * per vehicle, in display order, instead of 8 shades of its type color. No
 * red, orange, amber nor brown (hues from 345° to 45°): red says a problem
 * (return to check, unavailable) and amber a trip without a vehicle or a
 * pause. None of the type colors either (the VSL blue #2563eb). Dark enough
 * for a line on the light map; the type of the vehicle is told by its label or
 * badge, and on the map by the shape of its stops.
 */
export const DISPLAY_PALETTE = [
  "#1d4ed8", // blue
  "#16a34a", // green
  "#9333ea", // purple
  "#0891b2", // cyan
  "#c026d3", // fuchsia
  "#65a30d", // olive
  "#1e3a8a", // navy
  "#0d9488", // teal
  "#be185d", // raspberry
  "#4f46e5", // indigo
  "#475569", // slate
  "#166534", // dark green
] as const;

/** Color of a vehicle without a route (nothing drawn on the map). */
export const IDLE_VEHICLE_COLOR = "#94a3b8";

/**
 * Display color of each vehicle: the palette in the order of `ids` (the
 * vehicles with a route the filter keeps), then `extra` (the selected vehicle
 * shown whatever the filter) after them, so selecting it never recolors the
 * others. The palette repeats beyond 12 vehicles, never on neighbours.
 */
export function displayColors(ids: readonly string[], extra: string | null = null): Map<string, string> {
  const colors = new Map<string, string>();
  for (const id of ids) {
    if (!colors.has(id)) colors.set(id, DISPLAY_PALETTE[colors.size % DISPLAY_PALETTE.length]!);
  }
  if (extra !== null && !colors.has(extra)) colors.set(extra, DISPLAY_PALETTE[colors.size % DISPLAY_PALETTE.length]!);
  return colors;
}

/** WCAG relative luminance of a hex color. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** White or near-black text, whichever contrasts more with `background`. */
export function readableTextColor(background: string): "#ffffff" | "#0f172a" {
  const l = relativeLuminance(background);
  const onWhite = 1.05 / (l + 0.05);
  const onDark = (l + 0.05) / (relativeLuminance("#0f172a") + 0.05);
  return onWhite >= onDark ? "#ffffff" : "#0f172a";
}
