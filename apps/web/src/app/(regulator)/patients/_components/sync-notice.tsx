import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { saveNotice } from "../_lib/sync-notice";

/**
 * After a save that changed trips (redirect with ?courses=… and, when routes
 * were recomputed, ?tournees=…): what happened to the trips to come and to the
 * routes they left, with a link to « Courses ». Renders nothing otherwise.
 */
export function SyncNotice({
  query,
  className,
}: {
  /** The page's searchParams. */
  query: Record<string, string | string[] | undefined>;
  className?: string;
}) {
  const notice = saveNotice(query);
  if (!notice) return null;
  const { text, needsAction } = notice;
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
