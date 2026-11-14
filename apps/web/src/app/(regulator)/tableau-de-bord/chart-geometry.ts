/**
 * Geometry and text summary of the dashboard's small bar charts. Pure (no
 * React, no database) so it is unit-tested. The SVG has no viewBox: x is in
 * percent of the chart width, y in pixels, so bars keep a fixed pixel width
 * and their rounded ends are never stretched.
 */

export type ChartPoint = {
  /** Date of the day, or first day of the week or month: the key of the step. */
  date: string;
  /** Bar value; null = no data that day (nothing drawn, distinct from 0). */
  value: number | null;
  /** Optional second series drawn as a dot on the same scale. */
  secondary?: number | null;
  /** Optional moving average drawn as a line on the same scale (KPI-09). */
  average?: number | null;
};

/** Reference and objective of the indicator, drawn as dashed horizontal lines (KPI-09). */
export type ChartGuides = { reference?: number | null; objective?: number | null };

export type BarShape = {
  date: string;
  /** Center of the slot, percent of the width. */
  centerPct: number;
  /** Slot (hover target) start and width, percent of the width. */
  slotPct: number;
  slotWidthPct: number;
  /** Bar box in pixels, null when the value is unknown. */
  bar: { y: number; height: number; negative: boolean } | null;
  /** Y of the secondary dot in pixels, null when unknown. */
  dotY: number | null;
  /** Y of the moving average in pixels, null when unknown. */
  lineY: number | null;
};

export type ChartGeometry = {
  height: number;
  /** Y of the zero baseline in pixels. */
  zeroY: number;
  barWidth: number;
  radius: number;
  shapes: BarShape[];
  /** Y of the dashed lines in pixels, null when there is none. */
  referenceY: number | null;
  objectiveY: number | null;
  /** Segments of the moving average between consecutive known values (x in percent, y in pixels). */
  segments: { x1: number; y1: number; x2: number; y2: number }[];
};

/** Room above the tallest mark (dot radius + its ring) and below the lowest one. */
const PAD_TOP = 6;
const PAD_BOTTOM = 2;
/** Zero still draws a visible stub, so 0 is not mistaken for "no data". */
const MIN_BAR_PX = 1.5;

/** Bar thickness in pixels: thin marks, thinner as the range grows. */
export function barWidthFor(count: number): number {
  if (count <= 10) return 14;
  if (count <= 21) return 10;
  if (count <= 45) return 6;
  return 3;
}

function known(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

export function chartGeometry(points: readonly ChartPoint[], height = 64, guides: ChartGuides = {}): ChartGeometry {
  const values: number[] = [];
  for (const p of points) {
    if (known(p.value)) values.push(p.value);
    if (known(p.secondary)) values.push(p.secondary);
    if (known(p.average)) values.push(p.average);
  }
  // The dashed lines are in the scale only when the chart has data: they never draw an empty chart's axis.
  if (values.length > 0) {
    if (known(guides.reference)) values.push(guides.reference);
    if (known(guides.objective)) values.push(guides.objective);
  }
  const min = Math.min(0, ...values);
  // All zero (or no data): keep the baseline at the bottom.
  const rawMax = Math.max(0, ...values);
  const max = rawMax === 0 && min === 0 ? 1 : rawMax;
  const span = max - min;
  const plot = height - PAD_TOP - PAD_BOTTOM;
  const y = (v: number) => PAD_TOP + ((max - v) / span) * plot;
  const zeroY = y(0);
  const count = points.length;
  const barWidth = barWidthFor(count);
  const slotWidthPct = count > 0 ? 100 / count : 100;

  const shapes = points.map((p, i): BarShape => {
    let bar: BarShape["bar"] = null;
    if (p.value !== null && Number.isFinite(p.value)) {
      const top = y(p.value);
      const size = Math.max(Math.abs(zeroY - top), MIN_BAR_PX);
      const negative = p.value < 0;
      bar = { y: negative ? zeroY : zeroY - size, height: size, negative };
    }
    return {
      date: p.date,
      centerPct: (i + 0.5) * slotWidthPct,
      slotPct: i * slotWidthPct,
      slotWidthPct,
      bar,
      dotY: known(p.secondary) ? y(p.secondary) : null,
      lineY: known(p.average) ? y(p.average) : null,
    };
  });

  // The moving average runs over working days: it joins its known values across the days off between them.
  const segments: ChartGeometry["segments"] = [];
  let previous: BarShape | null = null;
  for (const shape of shapes) {
    if (shape.lineY === null) continue;
    if (previous && previous.lineY !== null) segments.push({ x1: previous.centerPct, y1: previous.lineY, x2: shape.centerPct, y2: shape.lineY });
    previous = shape;
  }
  const guideY = (value: number | null | undefined) => (values.length > 0 && known(value) ? y(value) : null);

  return {
    height,
    zeroY,
    barWidth,
    radius: Math.min(4, barWidth / 2),
    shapes,
    referenceY: guideY(guides.reference),
    objectiveY: guideY(guides.objective),
    segments,
  };
}

/**
 * Accessible summary of a series for aria-label: range, number of days with
 * data, minimum, maximum and last known value with their dates.
 */
export function describeSeries(
  title: string,
  points: readonly ChartPoint[],
  format: (value: number) => string,
  formatDate: (date: string) => string,
): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return `${title}\u00a0: aucune donnée.`;
  const range = `du ${formatDate(first.date)} au ${formatDate(last.date)}`;
  const known = points.filter((p): p is ChartPoint & { value: number } => p.value !== null && Number.isFinite(p.value));
  const head = known[0];
  if (!head) return `${title}, ${range}\u00a0: aucune donnée.`;

  let lowest = head;
  let highest = head;
  for (const p of known) {
    if (p.value < lowest.value) lowest = p;
    if (p.value > highest.value) highest = p;
  }
  const latest = known[known.length - 1] ?? head;
  const days = known.length > 1 ? `${known.length} jours renseignés` : "1 jour renseigné";
  return (
    `${title}, ${range}\u00a0: ${days}\u202f; minimum ${format(lowest.value)} le ${formatDate(lowest.date)}, ` +
    `maximum ${format(highest.value)} le ${formatDate(highest.date)}, ` +
    `dernière valeur ${format(latest.value)} le ${formatDate(latest.date)}.`
  );
}
