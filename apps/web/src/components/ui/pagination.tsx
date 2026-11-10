import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { pageItems } from "@/lib/list-filters";
import { buttonClasses } from "./button";
import { cn } from "./cn";

/**
 * Pages of a long list (Patients): previous, the first, last and nearby
 * pages, next. `hrefOf` builds the address of a page with the filters in use.
 */
export function Pagination({
  page,
  pageCount,
  hrefOf,
  label = "Pages de la liste",
  className,
}: {
  page: number;
  pageCount: number;
  hrefOf: (page: number) => string;
  label?: string;
  className?: string;
}) {
  if (pageCount <= 1) return null;
  const step = (target: number, children: ReactNode, ariaLabel: string) =>
    target < 1 || target > pageCount ? (
      <span aria-hidden className={buttonClasses("ghost", "sm", "text-slate-300")}>
        {children}
      </span>
    ) : (
      <Link href={hrefOf(target)} aria-label={ariaLabel} className={buttonClasses("ghost", "sm")}>
        {children}
      </Link>
    );
  return (
    <nav aria-label={label} className={cn("flex flex-wrap items-center gap-1", className)}>
      {step(
        page - 1,
        <>
          <ChevronLeft aria-hidden className="size-4" />
          Précédente
        </>,
        "Page précédente",
      )}
      <ul className="flex flex-wrap items-center gap-1">
        {pageItems(page, pageCount).map((item, index) =>
          item === "…" ? (
            <li key={`gap-${index}`} aria-hidden className="px-1 text-sm text-slate-400">
              …
            </li>
          ) : (
            <li key={item}>
              <Link
                href={hrefOf(item)}
                aria-current={item === page ? "page" : undefined}
                aria-label={`Page ${item}`}
                className={cn(
                  buttonClasses(item === page ? "primary" : "ghost", "sm", "tabular min-w-8"),
                  item === page && "pointer-events-none",
                )}
              >
                {item}
              </Link>
            </li>
          ),
        )}
      </ul>
      {step(
        page + 1,
        <>
          Suivante
          <ChevronRight aria-hidden className="size-4" />
        </>,
        "Page suivante",
      )}
    </nav>
  );
}
