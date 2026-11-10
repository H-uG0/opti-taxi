import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

/** Link back to the parent list or record, above the page header. The one back link of the app. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="mb-2 inline-flex min-h-6 items-center gap-1 rounded-sm text-sm text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
    >
      <ChevronLeft aria-hidden className="size-4" />
      {children}
    </Link>
  );
}
