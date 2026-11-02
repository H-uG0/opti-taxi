/**
 * Vehicle colors: every vehicle uses its type color (taxi, VSL, ambulance),
 * shaded so that two vehicles of the same type stay distinguishable on the
 * timeline and the map. Pure: hex strings in, hex strings out.
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

/** Color used when two patients ride together. */
export function sharedLoadColor(vehicleHex: string): string {
  return shade(vehicleHex, 0.35);
}
