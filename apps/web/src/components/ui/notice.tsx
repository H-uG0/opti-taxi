import type { ReactNode } from "react";
import { CircleCheck, Info, TriangleAlert } from "lucide-react";
import { cn } from "./cn";

export type NoticeTone = "info" | "warning" | "danger" | "success";

const TONES: Record<NoticeTone, { box: string; icon: string }> = {
  info: { box: "border-sky-200 bg-sky-50 text-sky-900", icon: "text-sky-700" },
  warning: { box: "border-amber-200 bg-amber-50 text-amber-950", icon: "text-amber-700" },
  danger: { box: "border-red-200 bg-red-50 text-red-900", icon: "text-red-700" },
  success: { box: "border-emerald-200 bg-emerald-50 text-emerald-900", icon: "text-emerald-700" },
};

/**
 * A notice on a page or in a form: information, warning, problem or success, with an optional
 * title. `size="sm"`: a one-line note under a field or in a list. Server- and client-safe.
 * `role`: « status » for a result just announced, « alert » for a refusal, « note » otherwise.
 */
export function Notice({
  tone = "info",
  title,
  size = "md",
  role,
  className,
  children,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  size?: "sm" | "md";
  role?: "note" | "status" | "alert";
  className?: string;
  children: ReactNode;
}) {
  const Icon = tone === "info" ? Info : tone === "success" ? CircleCheck : TriangleAlert;
  const small = size === "sm";
  return (
    <div
      role={role}
      className={cn(
        "flex rounded-md border",
        small ? "items-start gap-2 px-3 py-2 text-xs" : "gap-3 rounded-lg px-4 py-3 text-sm",
        TONES[tone].box,
        className,
      )}
    >
      <Icon aria-hidden className={cn("shrink-0", small ? "mt-0.5 size-3.5" : "mt-0.5 size-4", TONES[tone].icon)} />
      <div className={cn("min-w-0", !small && "space-y-1")}>
        {title ? <p className="font-semibold">{title}</p> : null}
        <div className={cn(!small && "space-y-1 leading-relaxed")}>{children}</div>
      </div>
    </div>
  );
}

/** Inline warning shown under a field (live client-side check; the server re-validates). */
export function InlineWarning({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-start gap-1 font-medium text-amber-800">
      <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </span>
  );
}
