import { cn } from "@/components/ui/cn";
import { chartGeometry, describeSeries, type ChartPoint } from "./chart-geometry";
import { formatDayMonth, formatDayShort } from "./format";

/**
 * Small inline SVG bar chart, one bar per day (no chart library). The focus
 * day is drawn in the accent shade; an optional second series is drawn as
 * dots. The whole chart is one image for assistive technologies (role="img"
 * + summary); every value is also in the table below. Hovering a day shows
 * its value (native SVG tooltip).
 */
export function BarChart({
  title,
  points,
  format,
  focusDate,
  primaryLabel,
  secondaryLabel,
  height = 64,
}: {
  title: string;
  points: ChartPoint[];
  format: (value: number) => string;
  focusDate?: string | null;
  /** Legend names, given only when the chart has two series. */
  primaryLabel?: string;
  secondaryLabel?: string;
  height?: number;
}) {
  const geometry = chartGeometry(points, height);
  const { zeroY, barWidth, radius } = geometry;
  const hasSecondary = secondaryLabel !== undefined && points.some((p) => p.secondary !== undefined && p.secondary !== null);
  let label = describeSeries(primaryLabel ? `${title} (${primaryLabel.toLowerCase()})` : title, points, format, formatDayShort);
  if (hasSecondary && secondaryLabel) {
    const secondary = points.map((p) => ({ date: p.date, value: p.secondary ?? null }));
    label += ` ${describeSeries(secondaryLabel, secondary, format, formatDayShort)}`;
  }
  const first = points[0];
  const last = points[points.length - 1];

  return (
    <figure className="min-w-0">
      {hasSecondary ? (
        <figcaption className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2.5 w-2 rounded-t-[2px] bg-brand-500" />
            {primaryLabel}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-2 rounded-full bg-slate-800" />
            {secondaryLabel}
          </span>
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
        {/* Hover targets, the full height of each day's slot, on top of the marks. */}
        {geometry.shapes.map((shape, i) => {
          const point = points[i];
          const value = point?.value ?? null;
          const secondary = point?.secondary ?? null;
          let tooltip = `${formatDayShort(shape.date)}\u00a0: ${value === null ? "pas de donnée" : format(value)}`;
          if (hasSecondary && secondaryLabel) {
            tooltip = `${formatDayShort(shape.date)}\u00a0: ${primaryLabel ?? title} ${value === null ? "—" : format(value)} · ${secondaryLabel} ${secondary === null ? "—" : format(secondary)}`;
          }
          return (
            <rect
              key={`hit-${shape.date}`}
              x={`${shape.slotPct}%`}
              y={0}
              width={`${shape.slotWidthPct}%`}
              height={height}
              className={cn(
                shape.date === focusDate ? "fill-brand-500/10" : "fill-transparent",
                "hover:fill-slate-900/5",
              )}
            >
              <title>{tooltip}</title>
            </rect>
          );
        })}
      </svg>
      {first && last ? (
        <div aria-hidden className="tabular mt-1 flex justify-between text-[11px] text-slate-500">
          <span>{formatDayMonth(first.date)}</span>
          {first.date !== last.date ? <span>{formatDayMonth(last.date)}</span> : null}
        </div>
      ) : null}
    </figure>
  );
}
