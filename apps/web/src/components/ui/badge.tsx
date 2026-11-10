import type { ReactNode } from "react";
import { cn } from "./cn";
import { VEHICLE_TYPE_SHORT } from "@/lib/labels";

/** `simulated`: rows produced by the history simulation (pnpm db:history), never measurements. */
export type BadgeTone = "neutral" | "brand" | "success" | "warning" | "danger" | "info" | "simulated";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-200",
  brand: "bg-brand-50 text-brand-800 ring-brand-200",
  success: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  warning: "bg-amber-50 text-amber-800 ring-amber-200",
  danger: "bg-red-50 text-red-800 ring-red-200",
  info: "bg-sky-50 text-sky-800 ring-sky-200",
  simulated: "bg-violet-50 text-violet-800 ring-violet-200",
};

export function Badge({ tone = "neutral", className, children }: { tone?: BadgeTone; className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", tones[tone], className)}>
      {children}
    </span>
  );
}

/** CSS color of each vehicle type (see --color-taxi/vsl/ambulance in globals.css). */
export const VEHICLE_TYPE_COLORS = {
  TAXI: "var(--color-taxi)",
  VSL: "var(--color-vsl)",
  AMBULANCE: "var(--color-ambulance)",
} as const;

/** Hex values of the same colors, for canvases such as MapLibre that cannot read CSS variables. */
export const VEHICLE_TYPE_HEX = {
  TAXI: "#c27c0e",
  VSL: "#2563eb",
  AMBULANCE: "#dc2626",
} as const;

/**
 * The vehicle type, with a dot of its color. `dot={false}` on the planning screens: there a colored dot is the
 * vehicle's own display color (timeline, map), never its type's.
 */
export function VehicleTypeBadge({ type, dot = true }: { type: keyof typeof VEHICLE_TYPE_SHORT; dot?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-800 ring-1 ring-inset ring-slate-200">
      {dot ? <span aria-hidden className="size-2 rounded-full" style={{ background: VEHICLE_TYPE_COLORS[type] }} /> : null}
      {VEHICLE_TYPE_SHORT[type]}
    </span>
  );
}
