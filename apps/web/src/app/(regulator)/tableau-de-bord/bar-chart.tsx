import { cn } from "@/components/ui/cn";
import { chartGeometry, describeSeries, type ChartGuides, type ChartPoint } from "./chart-geometry";

/**
 * Small inline SVG bar chart, one bar per day, week or month (no chart
 * library). The focus step is drawn in the accent shade; an optional second
 * series is drawn as dots, the moving average as a line, the reference and
 * the objective as dashed lines (KPI-09). The whole chart is one image for
 * assistive technologies (role="img" + summary); every value is also in the
 * table of the page. Hovering a step shows its values (native SVG tooltip).
 */
export function BarChart({
  title,
  points,
  format,
  formatKey,
  formatEdge,
  focusDate,
  primaryLabel,
  secondaryLabel,
  averageLabel,
  guides = {},
  height = 64,
}: {
  title: string;
  points: ChartPoint[];
  format: (value: number) => string;
  /** The step of a point in words (« mar. 03/11 », « sem. du 02/11 », « novembre 2026 »). */
  formatKey: (key: string) => string;
  /** The step under the first and last bars (« 03/11 », « nov. »). */
  formatEdge: (key: string) => string;
  focusDate?: string | null;
  /** Legend name of the bars (the series, or the step when it is the only one). */
  primaryLabel?: string;
  secondaryLabel?: string;
  averageLabel?: string;
  guides?: ChartGuides;
  height?: number;
}) {
  const geometry = chartGeometry(points, height, guides);
  const { zeroY, barWidth, radius } = geometry;
  const hasSecondary = secondaryLabel !== undefined && points.some((p) => p.secondary !== undefined && p.secondary !== null);
  const hasAverage = averageLabel !== undefined && geometry.segments.length > 0;
  const barsLabel = primaryLabel ?? title;
  let label = describeSeries(primaryLabel ? `${title} (${primaryLabel.toLowerCase()})` : title, points, format, formatKey);
  if (hasSecondary && secondaryLabel) {
    label += ` ${describeSeries(secondaryLabel, points.map((p) => ({ date: p.date, value: p.secondary ?? null })), format, formatKey)}`;
  }
  const guideText = [
    geometry.objectiveY !== null && guides.objective !== null && guides.objective !== undefined ? `Objectif : ${format(guides.objective)}.` : null,
    geometry.referenceY !== null && guides.reference !== null && guides.reference !== undefined ? `Référence : ${format(guides.reference)}.` : null,
  ].filter(Boolean);
  if (guideText.length > 0) label += ` ${guideText.join(" ")}`;
  const legend = hasSecondary || hasAverage || geometry.objectiveY !== null || geometry.referenceY !== null;
  const first = points[0];
  const last = points[points.length - 1];

  return (
    <figure className="min-w-0">
      {legend ? (
        <figcaption className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2.5 w-2 rounded-t-[2px] bg-brand-500" />
            {barsLabel}
          </span>
          {hasSecondary ? (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full bg-slate-800" />
              {secondaryLabel}
            </span>
          ) : null}
          {hasAverage ? (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="h-0.5 w-3.5 rounded-full bg-slate-700" />
              {averageLabel}
            </span>
          ) : null}
          {geometry.objectiveY !== null && guides.objective !== null && guides.objective !== undefined ? (
            <span className="inline-flex items-center gap-1.5">
              <svg aria-hidden width="14" height="4" className="overflow-visible">
                <line x1="0" x2="14" y1="2" y2="2" className="stroke-slate-900" strokeWidth={1.5} strokeDasharray="4 2" />
              </svg>
              <span>
                Objectif <span className="tabular">{format(guides.objective)}</span>
              </span>
            </span>
          ) : null}
          {geometry.referenceY !== null && guides.reference !== null && guides.reference !== undefined ? (
            <span className="inline-flex items-center gap-1.5">
              <svg aria-hidden width="14" height="4" className="overflow-visible">
                <line x1="0" x2="14" y1="2" y2="2" className="stroke-slate-400" strokeWidth={1.5} strokeDasharray="1.5 2" />
              </svg>
              <span>
                Référence <span className="tabular">{format(guides.reference)}</span>
              </span>
            </span>
          ) : null}
        </figcaption>
      ) : null}
      <svg role="img" aria-label={label} width="100%" height={height} className="block overflow-visible">
        <line x1="0" x2="100%" y1={zeroY} y2={zeroY} className="stroke-slate-300" strokeWidth={1} />
        {geometry.shapes.map((shape) => {
          const isFocus = shape.date === focusDate;
          const bar = shape.bar;
          // A rounded data end and a square end on the baseline: the square patch covers the baseline corners.
          const patch = bar ? Math.min(radius, bar.height) : 0;
          return (
            <g key={shape.date} className={isFocus ? "fill-brand-800" : "fill-brand-500"}>
              {bar ? (
                <>
                  <rect
                    x={`${shape.centerPct}%`}
                    y={bar.y}
                    width={barWidth}
                    height={bar.height}
                    rx={Math.min(radius, bar.height / 2)}
                    transform={`translate(${-barWidth / 2} 0)`}
                  />
                  <rect
                    x={`${shape.centerPct}%`}
                    y={bar.negative ? bar.y : bar.y + bar.height - patch}
                    width={barWidth}
                    height={patch}
                    transform={`translate(${-barWidth / 2} 0)`}
                  />
                </>
              ) : null}
            </g>
          );
        })}
        {geometry.referenceY !== null ? (
          <line x1="0" x2="100%" y1={geometry.referenceY} y2={geometry.referenceY} className="stroke-slate-400" strokeWidth={1.5} strokeDasharray="1.5 2" />
        ) : null}
        {geometry.objectiveY !== null ? (
          <line x1="0" x2="100%" y1={geometry.objectiveY} y2={geometry.objectiveY} className="stroke-slate-900" strokeWidth={1.5} strokeDasharray="4 2" />
        ) : null}
        {hasAverage
          ? geometry.segments.map((segment) => (
              <g key={`avg-${segment.x1}`} strokeLinecap="round">
                {/* A ring in the surface colour keeps the line readable where it crosses a bar. */}
                <line x1={`${segment.x1}%`} x2={`${segment.x2}%`} y1={segment.y1} y2={segment.y2} className="stroke-white" strokeWidth={4} />
                <line x1={`${segment.x1}%`} x2={`${segment.x2}%`} y1={segment.y1} y2={segment.y2} className="stroke-slate-700" strokeWidth={2} />
              </g>
            ))
          : null}
        {hasSecondary
          ? geometry.shapes.map((shape) =>
              shape.dotY !== null ? (
                <circle
                  key={`dot-${shape.date}`}
                  cx={`${shape.centerPct}%`}
                  cy={shape.dotY}
                  r={3.5}
                  className="fill-slate-800 stroke-white"
                  strokeWidth={2}
                />
              ) : null,
            )
          : null}
        {/* Hover targets, the full height of each step's slot, on top of the marks. */}
        {geometry.shapes.map((shape, i) => {
          const point = points[i];
          const show = (value: number | null | undefined) => (value === null || value === undefined ? "—" : format(value));
          const parts = [`${barsLabel} ${show(point?.value)}`];
          if (hasSecondary && secondaryLabel) parts.push(`${secondaryLabel} ${show(point?.secondary)}`);
          if (hasAverage && averageLabel) parts.push(`${averageLabel} ${show(point?.average)}`);
          const tooltip =
            parts.length === 1 && (point?.value === null || point?.value === undefined)
              ? `${formatKey(shape.date)} : pas de donnée`
              : `${formatKey(shape.date)} : ${parts.join(" · ")}`;
          return (
            <rect
              key={`hit-${shape.date}`}
              x={`${shape.slotPct}%`}
              y={0}
              width={`${shape.slotWidthPct}%`}
              height={height}
              className={cn(shape.date === focusDate ? "fill-brand-500/10" : "fill-transparent", "hover:fill-slate-900/5")}
            >
              <title>{tooltip}</title>
            </rect>
          );
        })}
      </svg>
      {first && last ? (
        <div aria-hidden className="tabular mt-1 flex justify-between text-[11px] text-slate-500">
          <span>{formatEdge(first.date)}</span>
          {first.date !== last.date ? <span>{formatEdge(last.date)}</span> : null}
        </div>
      ) : null}
    </figure>
  );
}
