import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { decodeSync, describeSync } from "../_lib/trip-sync";

/**
 * After a save that changed trips (redirect with ?courses=…): what happened to
 * the trips to come, with a link to « Courses ». Renders nothing otherwise.
 */
export function SyncNotice({ value, className }: { value: string | string[] | undefined; className?: string }) {
  const summary = decodeSync(Array.isArray(value) ? value[0] : value);
  const text = summary ? describeSync(summary) : null;
  if (!summary || !text) return null;
  const needsAction = summary.detached > 0 || summary.deferred > 0;
  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-start gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm",
        needsAction ? "border-amber-200 bg-amber-50 text-amber-900" : "border-sky-200 bg-sky-50 text-sky-800",
        className,
      )}
    >
      <RefreshCw aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 flex-1">{text}</p>
      <Link href="/courses" className="font-medium underline underline-offset-2 hover:no-underline">
        Voir les courses
      </Link>
    </div>
  );
}
