import Link from "next/link";
import { cn } from "@/components/ui/cn";

/** Today / tomorrow tabs of the roadmap: the two days a driver looks at. */
export function DaySwitch({ date, today, tomorrow }: { date: string; today: string; tomorrow: string }) {
  const tabs = [
    { iso: today, href: "/chauffeur", label: "Aujourd'hui" },
    { iso: tomorrow, href: `/chauffeur?date=${tomorrow}`, label: "Demain" },
  ];
  return (
    <nav aria-label="Jour affiché" className="grid grid-cols-2 gap-1 rounded-2xl bg-slate-200 p-1">
      {tabs.map((tab) => {
        const active = tab.iso === date;
        return (
          <Link
            key={tab.iso}
            href={tab.href}
            prefetch={false}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-11 touch-manipulation items-center justify-center rounded-xl text-base font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
              active ? "bg-white text-brand-800 shadow-sm" : "text-slate-700 hover:bg-slate-100",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
