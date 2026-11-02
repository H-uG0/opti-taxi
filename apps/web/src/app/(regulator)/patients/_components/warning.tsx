import type { ReactNode } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { cn } from "@/components/ui/cn";

/** Inline, non-blocking warning (inconsistent prescription, expiry…). Server- and client-safe. */
export function Warning({
  tone = "warning",
  children,
  className,
}: {
  tone?: "warning" | "danger" | "info";
  children: ReactNode;
  className?: string;
}) {
  const tones = {
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    danger: "border-red-200 bg-red-50 text-red-800",
    info: "border-sky-200 bg-sky-50 text-sky-800",
  } as const;
  const Icon = tone === "info" ? Info : AlertTriangle;
  return (
    <p className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-xs", tones[tone], className)}>
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
