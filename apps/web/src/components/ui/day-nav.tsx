"use client";

import { useEffect, useRef, useTransition, type FormEvent, type ReactNode } from "react";
import Link, { useLinkStatus } from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import { buttonClasses } from "./button";
import { cn } from "./cn";
import { Input } from "./form";
import { requestLeave } from "./leave-guard";
import { isShortcutKey } from "@/lib/planning/shortcuts";
import { addDays, formatShortDate, isIsoDate } from "@/lib/time";

const FIRST_DAY = "2000-01-01";
const LAST_DAY = "2100-12-31";

/** A complete date in range, different from the one shown: the date field may navigate to it. */
export function dateToShow(value: string, current: string): string | null {
  if (!isIsoDate(value) || value < FIRST_DAY || value > LAST_DAY || value === current) return null;
  return value;
}

/** The address of `day` on `basePath`, with the page's parameters (filters) and never a selection of the other day. */
export function dayHref(basePath: string, day: string, kept: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams({ ...kept, date: day });
  return `${basePath}?${params.toString()}`;
}

/** Inside a date link: its icon, or a spinner while the other date loads (same size: no layout shift). */
function LinkIcon({ children }: { children: ReactNode }) {
  const { pending } = useLinkStatus();
  return pending ? <LoaderCircle aria-hidden className="size-4 motion-safe:animate-spin" /> : children;
}

/** Inside a text link: dimmed while the date loads. */
function LinkLabel({ children }: { children: ReactNode }) {
  const { pending } = useLinkStatus();
  return <span className={cn("transition-opacity", pending && "opacity-50")}>{children}</span>;
}

/**
 * The day picker of every day screen (Planning, Courses, Équipages, Transports partagés): previous
 * and next day (the date in their name), a date field and « Demain », or a « J+1 » marker on J+1
 * (`tomorrowMarker={false}` when the page title already says it, as the planning's badge).
 * The date field never navigates while it is being typed: the date is taken on Entrée, when the
 * field loses the focus, or with « Afficher ». A GET form underneath: it works without JavaScript.
 * Unsaved changes of the page (LeaveGuard) are asked about before another day is shown.
 *
 * `keepParams`: query parameters kept from the current address (planning and Équipages filters);
 * `params`: parameters given by the page (Courses filters, read on the server).
 */
export function DayNav({
  basePath,
  date,
  tomorrow,
  keepParams = [],
  params = {},
  shortcuts = false,
  fieldLabel = "Date",
  tomorrowMarker = true,
  className,
}: {
  basePath: string;
  date: string;
  tomorrow: string;
  keepParams?: readonly string[];
  params?: Readonly<Record<string, string>>;
  /** « [ » and « ] » go to the previous and next day (the planning). */
  shortcuts?: boolean;
  fieldLabel?: string;
  /** The « J+1 » marker on J+1 (instead of « Demain »). */
  tomorrowMarker?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const search = useSearchParams();
  const [navigating, startTransition] = useTransition();
  const kept: Record<string, string> = { ...params };
  for (const key of keepParams) {
    const value = search.get(key);
    if (value) kept[key] = value;
  }
  const previous = addDays(date, -1);
  const next = addDays(date, 1);
  const inputId = `day-nav${basePath.replace(/[^a-z0-9]+/gi, "-")}`;

  const field = useRef<HTMLInputElement>(null);
  // The day being asked for: leaving the field for « Afficher » commits once, not twice.
  const asked = useRef<string | null>(null);
  useEffect(() => {
    asked.current = null;
  }, [date]);
  const go = (day: string, from: Record<string, string> = kept) => {
    if (asked.current === day) return;
    asked.current = day;
    void requestLeave().then((leave) => {
      if (leave) {
        startTransition(() => router.push(dayHref(basePath, day, from)));
        return;
      }
      // Kept on the date shown: the field says so again.
      asked.current = null;
      if (field.current) field.current.value = date;
    });
  };

  useEffect(() => {
    if (!shortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "[" && e.key !== "]") || !isShortcutKey(e)) return;
      e.preventDefault();
      // The address as it is now: the planning rewrites its filters in place (history.replaceState).
      const current = new URLSearchParams(window.location.search);
      const from: Record<string, string> = { ...params };
      for (const key of keepParams) {
        const value = current.get(key);
        if (value) from[key] = value;
      }
      go(addDays(date, e.key === "[" ? -1 : 1), from);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const commit = (value: string) => {
    const day = dateToShow(value, date);
    if (day) go(day);
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const field = event.currentTarget.elements.namedItem("date");
    if (field instanceof HTMLInputElement) commit(field.value);
  };

  return (
    <nav aria-label="Jour affiché" className={cn("flex flex-wrap items-center gap-1.5", navigating && "opacity-70", className)}>
      <Link
        href={dayHref(basePath, previous, kept)}
        className={buttonClasses("secondary")}
        aria-label={`Jour précédent (${formatShortDate(previous)})`}
        title={shortcuts ? "Jour précédent ([)" : "Jour précédent"}
        aria-keyshortcuts={shortcuts ? "[" : undefined}
      >
        <LinkIcon>
          <ChevronLeft aria-hidden className="size-4" />
        </LinkIcon>
      </Link>
      <form action={basePath} method="get" onSubmit={onSubmit} className="flex items-center gap-1.5">
        {Object.entries(kept).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <label htmlFor={inputId} className="sr-only">
          {fieldLabel}
        </label>
        {/* Uncontrolled, re-mounted per date: typing a day or a year goes through dates that must not be shown. */}
        <Input
          key={date}
          ref={field}
          id={inputId}
          type="date"
          name="date"
          defaultValue={date}
          min={FIRST_DAY}
          max={LAST_DAY}
          required
          onBlur={(e) => commit(e.currentTarget.value)}
          className="tabular w-auto"
        />
        <button type="submit" className={buttonClasses("secondary")}>
          Afficher
        </button>
      </form>
      <Link
        href={dayHref(basePath, next, kept)}
        className={buttonClasses("secondary")}
        aria-label={`Jour suivant (${formatShortDate(next)})`}
        title={shortcuts ? "Jour suivant (])" : "Jour suivant"}
        aria-keyshortcuts={shortcuts ? "]" : undefined}
      >
        <LinkIcon>
          <ChevronRight aria-hidden className="size-4" />
        </LinkIcon>
      </Link>
      {date !== tomorrow ? (
        <Link href={dayHref(basePath, tomorrow, kept)} className={buttonClasses("ghost")}>
          <LinkLabel>Demain</LinkLabel>
        </Link>
      ) : tomorrowMarker ? (
        <span className="px-2 text-sm font-medium text-brand-700">J+1</span>
      ) : null}
    </nav>
  );
}
