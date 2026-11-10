"use client";

import { useTransition, type ReactNode } from "react";
import { useLinkStatus } from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import { LinkButton } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { addDays, isIsoDate } from "@/lib/time";

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

export function DateNav({
  date,
  tomorrow,
  basePath = "/planning",
  keepParams = [],
}: {
  date: string;
  tomorrow: string;
  basePath?: string;
  /** Query parameters kept from one date to the next (the planning's filters). */
  keepParams?: readonly string[];
}) {
  const router = useRouter();
  const search = useSearchParams();
  const href = (day: string) => {
    const params = new URLSearchParams({ date: day });
    for (const key of keepParams) {
      const value = search.get(key);
      if (value) params.set(key, value);
    }
    return `${basePath}?${params.toString()}`;
  };
  const [navigating, startTransition] = useTransition();

  return (
    <nav aria-label="Date" className={cn("flex items-center gap-1.5", navigating && "opacity-70")}>
      <LinkButton href={href(addDays(date, -1))} aria-label="Jour précédent" title="Jour précédent">
        <LinkIcon>
          <ChevronLeft aria-hidden className="size-4" />
        </LinkIcon>
      </LinkButton>
      <label htmlFor="planning-date" className="sr-only">
        Date du planning
      </label>
      {/* Uncontrolled (re-mounted per date): typing a year goes through 0002, 0020… which must not navigate. */}
      <input
        key={date}
        id="planning-date"
        type="date"
        defaultValue={date}
        min="2000-01-01"
        max="2100-12-31"
        required
        onChange={(e) => {
          const value = e.currentTarget.value;
          if (isIsoDate(value) && value >= "2000-01-01" && value <= "2100-12-31" && value !== date) {
            startTransition(() => router.push(href(value)));
          }
        }}
        className="tabular h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 shadow-xs focus:border-brand-500 focus:outline-2 focus:outline-brand-200"
      />
      <LinkButton href={href(addDays(date, 1))} aria-label="Jour suivant" title="Jour suivant">
        <LinkIcon>
          <ChevronRight aria-hidden className="size-4" />
        </LinkIcon>
      </LinkButton>
      {date !== tomorrow ? (
        <LinkButton href={href(tomorrow)} variant="ghost">
          <LinkLabel>Demain</LinkLabel>
        </LinkButton>
      ) : null}
    </nav>
  );
}
