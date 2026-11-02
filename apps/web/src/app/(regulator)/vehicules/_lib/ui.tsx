/**
 * Small presentational pieces shared by the fleet referential screens.
 * No hooks: usable from server and client components.
 */
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { ChevronLeft, Info, TriangleAlert } from "lucide-react";
import { LinkButton } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatShortDate } from "@/lib/time";
import { upcomingRouteDates, upcomingRoutesNotice, type UpcomingRoute } from "./upcoming-routes";

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="mb-2 inline-flex items-center gap-1 rounded-sm text-sm text-slate-500 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-brand-600"
    >
      <ChevronLeft aria-hidden className="size-4" />
      {children}
    </Link>
  );
}

/** Numeric input with its unit displayed inside, right-aligned. Put the unit in the label too. */
export function UnitInput({ unit, className, ...props }: ComponentProps<"input"> & { unit: string }) {
  return (
    <div className="relative">
      <Input className={cn("tabular pr-14 text-right", className)} {...props} />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-slate-500"
      >
        {unit}
      </span>
    </div>
  );
}

export function Callout({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: "info" | "warning";
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const Icon = tone === "warning" ? TriangleAlert : Info;
  return (
    <div
      className={cn(
        "flex gap-3 rounded-lg border px-4 py-3 text-sm",
        tone === "warning" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-sky-200 bg-sky-50 text-sky-900",
        className,
      )}
    >
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", tone === "warning" ? "text-amber-600" : "text-sky-600")} />
      <div className="min-w-0 space-y-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        <div className="space-y-1 leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

const MAX_PLANNING_LINKS = 10;

/**
 * Upcoming routes still using a deactivated vehicle or driver, with a link to
 * the planning of each day so the regulator can re-run the optimisation.
 */
export function UpcomingRoutesCallout({
  routes,
  subject,
  className,
}: {
  routes: readonly UpcomingRoute[];
  subject: "vehicle" | "driver";
  className?: string;
}) {
  const notice = upcomingRoutesNotice(routes, subject);
  if (!notice) return null;
  const dates = upcomingRouteDates(routes).slice(0, MAX_PLANNING_LINKS);
  return (
    <Callout tone="warning" title="Tournées à replanifier" className={className}>
      <p>{notice}</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {dates.map((date) => (
          <li key={date}>
            <Link
              href={`/planning?date=${date}`}
              className="rounded-sm font-medium underline underline-offset-2 hover:text-amber-950 focus-visible:outline-2 focus-visible:outline-amber-600"
            >
              Planning du <span className="tabular">{formatShortDate(date)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Callout>
  );
}

/** Cancel + submit row at the bottom of an edit form. Render inside the <form>. */
export function FormFooter({
  cancelHref,
  submitLabel,
  pendingLabel = "Enregistrement…",
  children,
}: {
  cancelHref?: string;
  submitLabel: string;
  pendingLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 pt-4">
      {children ? <div className="mr-auto text-sm">{children}</div> : null}
      {cancelHref ? (
        <LinkButton href={cancelHref} variant="secondary">
          Annuler
        </LinkButton>
      ) : null}
      <SubmitButton pendingLabel={pendingLabel}>{submitLabel}</SubmitButton>
    </div>
  );
}

/** Inline warning shown under a field (live client-side check; the server re-validates). */
export function InlineWarning({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-start gap-1 font-medium text-amber-700">
      <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </span>
  );
}
