import Link from "next/link";
import { cn } from "@/components/ui/cn";

/** The four screens of a day, in the order of the dispatcher's work. */
export const DAY_TABS = [
  { href: "/planning", label: "Planning", title: "Tournées du jour" },
  { href: "/courses", label: "Courses", title: "Courses du jour : horaires, annulations, partage" },
  { href: "/equipages", label: "Équipages", title: "Équipages du jour : absences, remplaçants" },
  { href: "/arrivees-partagees", label: "Accueils", title: "Transports partagés : fiches à envoyer aux accueils des établissements" },
] as const;

export type DayTab = (typeof DAY_TABS)[number]["href"];

/**
 * Planning | Courses | Équipages | Accueils for the date shown: moving from one to the other keeps
 * the date (never the page's own filters, which mean something else on each screen).
 */
export function DayTabs({ current, date, className }: { current: DayTab; date: string; className?: string }) {
  return (
    <nav aria-label="Écrans du jour" className={cn("print:hidden", className)}>
      <ul className="inline-flex rounded-md border border-slate-300 bg-white p-0.5 shadow-xs">
        {DAY_TABS.map((tab) => {
          const active = tab.href === current;
          return (
            <li key={tab.href}>
              <Link
                href={`${tab.href}?date=${date}`}
                title={tab.title}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-8 items-center rounded px-3 text-sm font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-600",
                  active ? "bg-brand-700 text-white" : "text-slate-700 hover:bg-slate-100 hover:text-slate-900",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
