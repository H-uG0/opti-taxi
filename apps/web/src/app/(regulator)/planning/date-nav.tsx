"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { LinkButton } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { addDays, isIsoDate } from "@/lib/time";

const href = (date: string) => `/planning?date=${date}`;

export function DateNav({ date, tomorrow }: { date: string; tomorrow: string }) {
  const router = useRouter();
  const [navigating, startTransition] = useTransition();

  return (
    <nav aria-label="Date du planning" className={cn("flex items-center gap-1.5", navigating && "opacity-70")}>
      <LinkButton href={href(addDays(date, -1))} aria-label="Jour précédent" title="Jour précédent">
        <ChevronLeft aria-hidden className="size-4" />
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
        <ChevronRight aria-hidden className="size-4" />
      </LinkButton>
      {date !== tomorrow ? (
        <LinkButton href={href(tomorrow)} variant="ghost">
          Demain
        </LinkButton>
      ) : null}
    </nav>
  );
}
