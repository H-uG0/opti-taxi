/**
 * Small marker images of the planning map, drawn pixel by pixel (no canvas,
 * no font: the raster fallback style has no glyphs): the diamonds of a trip
 * without a vehicle and the warning sign of a violation. Pure, so it can be
 * unit-tested; MapLibre takes the result as is (map.addImage).
 */
import { hexToRgb } from "@/lib/planning/colors";

export type IconImage = { width: number; height: number; data: Uint8Array };

type Point = [number, number];

/** Signed distance of `p` to the border of a convex polygon (positive inside), the points in clockwise order on screen. */
function insideDistance(p: Point, polygon: readonly Point[]): number {
  let min = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i]!;
    const [bx, by] = polygon[(i + 1) % polygon.length]!;
    const length = Math.hypot(bx - ax, by - ay);
    // Clockwise on screen (y down): the inside is on the right of each edge.
    const d = ((bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax)) / length;
    min = Math.min(min, d);
  }
  return min;
}

type Paint = { fill: string; stroke: string; strokeWidth: number; extra?: (x: number, y: number) => boolean };

function paint(size: number, polygon: readonly Point[], { fill, stroke, strokeWidth, extra }: Paint): IconImage {
  const data = new Uint8Array(size * size * 4);
  const fillRgb = hexToRgb(fill);
  const strokeRgb = hexToRgb(stroke);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = insideDistance([x + 0.5, y + 0.5], polygon);
      const alpha = Math.min(1, Math.max(0, d + 0.5));
      if (alpha <= 0) continue;
      const rgb = d < strokeWidth || extra?.(x + 0.5, y + 0.5) ? strokeRgb : fillRgb;
      const i = (y * size + x) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = Math.round(alpha * 255);
    }
  }
  return { width: size, height: size, data };
}

/** A diamond (filled: pick-up; hollow, i.e. white inside: drop-off). */
export function diamondIcon(size: number, color: string, hollow: boolean): IconImage {
  const c = size / 2;
  const r = size / 2 - 1;
  const polygon: Point[] = [
    [c, c - r],
    [c + r, c],
    [c, c + r],
    [c - r, c],
  ];
  return paint(size, polygon, {
    fill: hollow ? "#ffffff" : color,
    stroke: hollow ? color : "#0f172a",
    strokeWidth: hollow ? size * 0.16 : size * 0.07,
  });
}

/** A warning sign: amber triangle, dark border and « ! ». */
export function warningIcon(size: number): IconImage {
  const c = size / 2;
  const polygon: Point[] = [
    [c, 1],
    [size - 1, size - 2],
    [1, size - 2],
  ];
  const bar = size * 0.065;
  return paint(size, polygon, {
    fill: "#fbbf24",
    stroke: "#0f172a",
    strokeWidth: size * 0.075,
    extra: (x, y) =>
      (Math.abs(x - c) <= bar && y >= size * 0.36 && y <= size * 0.66) || Math.hypot(x - c, y - size * 0.77) <= size * 0.075,
  });
}

/** Pixels of an image (tests): [r, g, b, a] at (x, y). */
export function pixelAt(image: IconImage, x: number, y: number): [number, number, number, number] {
  const i = (y * image.width + x) * 4;
  return [image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0, image.data[i + 3] ?? 0];
}
