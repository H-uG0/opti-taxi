"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  BarChart3,
  Building2,
  CalendarClock,
  Car,
  ContactRound,
  Euro,
  FileClock,
  ListChecks,
  Settings,
  Share2,
  UserRound,
  Users,
  Warehouse,
} from "lucide-react";
import { cn } from "@/components/ui/cn";
import { isIsoDate } from "@/lib/time";

/** The screens of one day: their links carry the date shown (?date=) from one to the other. */
export const DAY_SCREENS = ["/planning", "/courses", "/equipages", "/arrivees-partagees"] as const;

/** Every regulator page, by section. Owned here so feature folders never edit navigation. */
export const REGULATOR_NAV_SECTIONS = [
  {
    title: "Journée",
    links: [
      { href: "/planning", label: "Planning", icon: CalendarClock },
      { href: "/courses", label: "Courses", icon: ListChecks },
      { href: "/equipages", label: "Équipages", icon: ContactRound },
      { href: "/arrivees-partagees", label: "Transports partagés", icon: Share2 },
    ],
  },
  { title: "Suivi", links: [{ href: "/tableau-de-bord", label: "Tableau de bord", icon: BarChart3 }] },
  {
    title: "Référentiels",
    links: [
      { href: "/patients", label: "Patients", icon: Users },
      { href: "/prescriptions", label: "Prescriptions", icon: FileClock },
      { href: "/etablissements", label: "Établissements", icon: Building2 },
    ],
  },
  {
    title: "Flotte et personnel",
    links: [
      { href: "/depots", label: "Dépôts", icon: Warehouse },
      { href: "/vehicules", label: "Véhicules", icon: Car },
      { href: "/chauffeurs", label: "Personnel", icon: UserRound },
    ],
  },
  {
    title: "Réglages",
    links: [
      { href: "/tarifs", label: "Grilles tarifaires", icon: Euro },
      { href: "/parametres", label: "Paramètres", icon: Settings },
    ],
  },
] as const;

type NavLink = (typeof REGULATOR_NAV_SECTIONS)[number]["links"][number];

export const REGULATOR_NAV: readonly NavLink[] = REGULATOR_NAV_SECTIONS.flatMap((section): readonly NavLink[] => section.links);

type NavHref = NavLink["href"];

/** Pages with a count of things to handle, shown next to their link (e.g. prescriptions to renew). */
export type NavCounts = Partial<Record<NavHref, number>>;

/** The link of a menu entry: a day screen keeps the date shown (a valid ?date= of the current address). */
export function navHref(href: string, date: string | null): string {
  if (!date || !isIsoDate(date) || !(DAY_SCREENS as readonly string[]).includes(href)) return href;
  return `${href}?date=${date}`;
}

export function RegulatorNav({ horizontal = false, counts = {} }: { horizontal?: boolean; counts?: NavCounts }) {
  const pathname = usePathname();
  const date = useSearchParams().get("date");

  const item = ({ href, label, icon: Icon }: NavLink) => {
    const active = pathname === href || pathname.startsWith(`${href}/`);
    const count = counts[href] ?? 0;
    return (
      <li key={href}>
        <Link
          href={navHref(href, date)}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex min-h-9 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-brand-600",
            active ? "bg-brand-50 text-brand-800" : "text-slate-700 hover:bg-slate-100 hover:text-slate-900",
          )}
        >
          <Icon aria-hidden className="size-4 shrink-0" />
          {label}
          {count > 0 ? (
            <span className="tabular ml-auto rounded-full bg-amber-100 px-1.5 py-px text-xs font-semibold text-amber-900">
              {count}
              <span className="sr-only"> à traiter</span>
            </span>
          ) : null}
        </Link>
      </li>
    );
  };

  if (horizontal) {
    // Tablets and phones: one scrolling strip, a thin rule between sections.
    return (
      <nav aria-label="Navigation principale" className="overflow-x-auto">
        <ul className="flex items-center gap-1 px-3 py-2">
          {REGULATOR_NAV_SECTIONS.map((section, i) => [
            i > 0 ? <li key={`sep-${section.title}`} aria-hidden className="mx-1 h-5 w-px shrink-0 bg-slate-200" /> : null,
            ...section.links.map((link: NavLink) => item(link)),
          ])}
        </ul>
      </nav>
    );
  }

  return (
    <nav aria-label="Navigation principale" className="flex-1 overflow-y-auto py-2">
      {/* Section titles name their list (not headings: the page's h1 comes after the menu). */}
      {REGULATOR_NAV_SECTIONS.map((section, i) => (
        <div key={section.title} className="px-3 pt-2">
          <p id={`nav-section-${i}`} className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
            {section.title}
          </p>
          <ul aria-labelledby={`nav-section-${i}`} className="space-y-0.5">
            {section.links.map((link: NavLink) => item(link))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
