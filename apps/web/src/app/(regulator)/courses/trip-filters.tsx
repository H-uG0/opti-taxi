import Link from "next/link";
import { Search } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { DIRECTION_LABELS, SHARING_STATUS_LABELS, TRIP_STATUS_LABELS } from "@/lib/labels";
import { coursesHref, hasActiveFilters, type TripFilters } from "./trip-list";

const STATUS_OPTIONS = Object.entries(TRIP_STATUS_LABELS);
const SHARING_OPTIONS = Object.entries(SHARING_STATUS_LABELS);
const DIRECTION_OPTIONS = Object.entries(DIRECTION_LABELS);

/** Filters of the trips list as a GET form: the URL stays shareable and the page needs no JavaScript. */
export function TripFiltersForm({ date, filters }: { date: string; filters: TripFilters }) {
  return (
    <form action="/courses" method="get" role="search" aria-label="Filtrer les courses" className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="date" value={date} />
      <div className="w-56 space-y-1">
        <label htmlFor="filter-q" className="block text-xs font-medium text-slate-600">
          Patient
        </label>
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400" />
          <Input id="filter-q" name="q" type="search" defaultValue={filters.q} placeholder="Nom ou prénom" className="pl-8" />
        </div>
      </div>
      <div className="w-44 space-y-1">
        <label htmlFor="filter-status" className="block text-xs font-medium text-slate-600">
          Statut
        </label>
        <Select id="filter-status" name="statut" defaultValue={filters.status ?? ""}>
          <option value="">Tous</option>
          <option value="ACTIVE">Hors annulées</option>
          {STATUS_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>
      <div className="w-32 space-y-1">
        <label htmlFor="filter-direction" className="block text-xs font-medium text-slate-600">
          Sens
        </label>
        <Select id="filter-direction" name="sens" defaultValue={filters.direction ?? ""}>
          <option value="">Tous</option>
          {DIRECTION_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>
      <div className="w-48 space-y-1">
        <label htmlFor="filter-sharing" className="block text-xs font-medium text-slate-600">
          Partage
        </label>
        <Select id="filter-sharing" name="partage" defaultValue={filters.sharing ?? ""}>
          <option value="">Tous</option>
          <option value="SHARED">Partagées dans le planning</option>
          {SHARING_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" className={buttonClasses("secondary")}>
          Filtrer
        </button>
        {hasActiveFilters(filters) ? (
          <Link href={coursesHref(date)} className={buttonClasses("ghost")}>
            Réinitialiser
          </Link>
        ) : null}
      </div>
    </form>
  );
}
