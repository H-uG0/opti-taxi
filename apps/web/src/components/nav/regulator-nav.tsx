"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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

/** Every regulator page. Owned here so feature folders never edit navigation. */
export const REGULATOR_NAV = [
  { href: "/planning", label: "Planning J+1", icon: CalendarClock },
  { href: "/courses", label: "Courses", icon: ListChecks },
  { href: "/equipages", label: "Équipages", icon: ContactRound },
  { href: "/arrivees-partagees", label: "Arrivées partagées", icon: Share2 },
  { href: "/tableau-de-bord", label: "Tableau de bord", icon: BarChart3 },
  { href: "/patients", label: "Patients", icon: Users },
  { href: "/prescriptions", label: "Prescriptions", icon: FileClock },
  { href: "/etablissements", label: "Établissements", icon: Building2 },
  { href: "/depots", label: "Dépôts", icon: Warehouse },
  { href: "/vehicules", label: "Véhicules", icon: Car },
  { href: "/chauffeurs", label: "Chauffeurs", icon: UserRound },
  { href: "/tarifs", label: "Grilles tarifaires", icon: Euro },
  { href: "/parametres", label: "Paramètres", icon: Settings },
] as const;

/** Pages with a count of things to handle, shown next to their link (e.g. prescriptions to renew). */
export type NavCounts = Partial<Record<(typeof REGULATOR_NAV)[number]["href"], number>>;

export function RegulatorNav({ horizontal = false, counts = {} }: { horizontal?: boolean; counts?: NavCounts }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Navigation principale" className={cn(horizontal ? "overflow-x-auto" : "flex-1 overflow-y-auto py-3")}>
      <ul className={cn(horizontal ? "flex gap-1 px-3 py-2" : "space-y-0.5 px-3")}>
        {REGULATOR_NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          const count = counts[href] ?? 0;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium whitespace-nowrap transition-colors",
                  active ? "bg-brand-50 text-brand-800" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
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
        })}
      </ul>
    </nav>
  );
}
