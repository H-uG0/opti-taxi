/**
 * Small marker images of the planning map, drawn pixel by pixel (no canvas,
 * no font: the raster fallback style has no glyphs): the stops of a route, one
 * shape per vehicle type, the diamonds of a trip without a vehicle and the
 * warning sign of a violation. Pure, so it can be unit-tested; MapLibre takes
 * the result as is (map.addImage).
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

/** Signed distance to the border of a shape, positive inside. */
type Shape = readonly Point[] | ((p: Point) => number);

function paint(size: number, shape: Shape, { fill, stroke, strokeWidth, extra }: Paint): IconImage {
  const data = new Uint8Array(size * size * 4);
  const fillRgb = hexToRgb(fill);
  const strokeRgb = hexToRgb(stroke);
  const distance = typeof shape === "function" ? shape : (p: Point) => insideDistance(p, shape);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = distance([x + 0.5, y + 0.5]);
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

export type StopShapeType = "TAXI" | "VSL" | "AMBULANCE";

/** The square of a VSL, the cross of an ambulance (its two bars), in a `size` box. */
function square(size: number): Point[] {
  const lo = size * 0.12;
  const hi = size - lo;
  return [
    [lo, lo],
    [hi, lo],
    [hi, hi],
    [lo, hi],
  ];
}

function bar(x0: number, y0: number, x1: number, y1: number): Point[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** Where each type's stop is inside (signed distance): taxi a disc, VSL a square, ambulance a cross. */
function stopShape(type: StopShapeType, size: number): Shape {
  const c = size / 2;
  if (type === "TAXI") return ([x, y]: Point) => c - 1 - Math.hypot(x - c, y - c);
  if (type === "VSL") return square(size);
  const arm = size * 0.22;
  const across = bar(1, c - arm, size - 1, c + arm);
  const down = bar(c - arm, 1, c + arm, size - 1);
  return (p: Point) => Math.max(insideDistance(p, across), insideDistance(p, down));
}

/**
 * A stop of a route, by the shape of its vehicle's type (taxi: disc, VSL:
 * square, ambulance: cross) at its vehicle's color: filled with a white
 * border at a pick-up, white inside with a colored border at a drop-off.
 */
export function stopIcon(size: number, type: StopShapeType, color: string, kind: "PICKUP" | "DROPOFF"): IconImage {
  const pickup = kind === "PICKUP";
  return paint(size, stopShape(type, size), {
    fill: pickup ? color : "#ffffff",
    stroke: pickup ? "#ffffff" : color,
    strokeWidth: size * (pickup ? 0.1 : 0.13),
  });
}

/** Image name of a stop (`stopIcon`), built by the map's style expression from the stop's properties. */
export const STOP_ICON_PATTERN = /^stop:(TAXI|VSL|AMBULANCE):(PICKUP|DROPOFF):(#[0-9a-f]{6})$/i;

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
