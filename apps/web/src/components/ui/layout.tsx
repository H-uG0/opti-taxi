import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

export function PageHeader({
  title,
  description,
  actions,
  titleAside,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** On the title's line, at its right (the day screens' tabs): costs no height when the actions wrap below. */
  titleAside?: ReactNode;
  /** Replaces the bottom margin, e.g. in a full-height page that spaces its parts itself. */
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className ?? "mb-6")}>
      <div className={cn("min-w-0", titleAside ? "grow" : undefined)}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {titleAside}
        </div>
        {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("rounded-lg border border-slate-200 bg-white shadow-xs", className)} {...props} />;
}

export function CardHeader({ title, actions, className }: { title: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3", className)}>
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {actions}
    </div>
  );
}

export function CardBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("p-4", className)} {...props} />;
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      {children ? <div className="mt-1 text-sm text-slate-600">{children}</div> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

/** KPI tile. */
export function Stat({ label, value, hint, tone = "default" }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: "default" | "good" | "warn" | "bad" }) {
  const tones = {
    default: "text-slate-900",
    good: "text-emerald-700",
    warn: "text-amber-700",
    bad: "text-red-700",
  };
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-xs">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={cn("tabular mt-1 text-2xl font-semibold", tones[tone])}>{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}
