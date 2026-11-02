import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { addDays, formatShortDate, tomorrowIso } from "@/lib/time";

/**
 * Day picker of the planning screens: previous / next day, a date field and
 * a shortcut to J+1. Plain links and a GET form (works without JavaScript).
 * `params` are kept in every link (filters of the page).
 */
export function DayNav({
  basePath,
  date,
  params = {},
  className,
}: {
  basePath: string;
  date: string;
  params?: Record<string, string>;
  className?: string;
}) {
  const href = (day: string) => `${basePath}?${new URLSearchParams({ ...params, date: day }).toString()}`;
  const tomorrow = tomorrowIso();
  const previous = addDays(date, -1);
  const next = addDays(date, 1);
  const inputId = `day-nav${basePath.replace(/[^a-z0-9]+/gi, "-")}`;

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <Link
        href={href(previous)}
        className={buttonClasses("secondary")}
        aria-label={`Jour précédent (${formatShortDate(previous)})`}
        title="Jour précédent"
      >
        <ChevronLeft aria-hidden className="size-4" />
      </Link>
      <form action={basePath} method="get" className="flex items-center gap-2">
        {Object.entries(params).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <label htmlFor={inputId} className="sr-only">
          Date
        </label>
        <input
          id={inputId}
          type="date"
          name="date"
          defaultValue={date}
          required
          className="tabular h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 shadow-xs focus:border-brand-500 focus:outline-2 focus:outline-brand-200"
        />
        <button type="submit" className={buttonClasses("secondary")}>
          Afficher
        </button>
      </form>
      <Link
        href={href(next)}
        className={buttonClasses("secondary")}
        aria-label={`Jour suivant (${formatShortDate(next)})`}
        title="Jour suivant"
      >
        <ChevronRight aria-hidden className="size-4" />
      </Link>
      {date !== tomorrow ? (
        <Link href={href(tomorrow)} className={buttonClasses("ghost")}>
          Demain
        </Link>
      ) : (
        <span className="px-2 text-sm font-medium text-brand-700">J+1</span>
      )}
    </div>
  );
}
