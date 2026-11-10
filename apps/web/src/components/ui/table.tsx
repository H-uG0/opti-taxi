import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

/**
 * A table in a bordered frame that scrolls sideways when too wide. With
 * `stickyHeader`, the frame is never taller than the screen and scrolls
 * inside: the column headers stay visible over a long list (a sticky header
 * cannot follow the page through a frame that scrolls sideways).
 */
export function Table({
  className,
  stickyHeader = false,
  frameClassName,
  ...props
}: ComponentProps<"table"> & { stickyHeader?: boolean; frameClassName?: string }) {
  return (
    <div
      // relative: an absolutely placed element of a cell (sr-only text) stays inside the frame instead of widening the page.
      className={cn(
        "relative overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-xs",
        stickyHeader &&
          "max-h-[calc(100dvh-var(--demo-banner-h,0px)-1rem)] overflow-y-auto [&>table>thead]:sticky [&>table>thead]:top-0 [&>table>thead]:z-10 [&>table>thead]:shadow-[0_1px_0_var(--color-slate-200)]",
        frameClassName,
      )}
    >
      <table className={cn("min-w-full divide-y divide-slate-200 text-sm", className)} {...props} />
    </div>
  );
}

/** Column headers; in a Table with `stickyHeader` they stay at the top of the frame (a shadow replaces their border). */
export function THead({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={cn("bg-slate-50", className)} {...props} />;
}

export function TBody(props: ComponentProps<"tbody">) {
  return <tbody className="divide-y divide-slate-100" {...props} />;
}

export function Th({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      scope="col"
      className={cn("px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600", className)}
      {...props}
    />
  );
}

export function Td({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("px-3 py-2 align-middle text-slate-800", className)} {...props} />;
}

/**
 * Header of a group of rows (a depot): a row of its own, read by screen
 * readers as the heading of the rows under it.
 */
export function GroupHeaderRow({ colSpan, children, className }: { colSpan: number; children: ReactNode; className?: string }) {
  return (
    <tr className={cn("bg-slate-50", className)}>
      <th scope="rowgroup" colSpan={colSpan} className="px-3 py-1.5 text-left text-xs font-normal text-slate-600">
        {children}
      </th>
    </tr>
  );
}
