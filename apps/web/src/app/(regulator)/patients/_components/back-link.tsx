import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

/** Breadcrumb-style link back to the parent record, above the page header. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="mb-2 inline-flex items-center gap-1 rounded text-sm text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
    >
      <ChevronLeft aria-hidden className="size-4" />
      {children}
    </Link>
  );
}
