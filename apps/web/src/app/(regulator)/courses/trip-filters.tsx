import Link from "next/link";
import { Search, X } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { DIRECTION_LABELS, SHARING_STATUS_LABELS, TRIP_STATUS_LABELS } from "@/lib/labels";
import { coursesHref, hasActiveFilters, type TripFilters } from "./trip-list";

const STATUS_OPTIONS = Object.entries(TRIP_STATUS_LABELS);
const SHARING_OPTIONS = Object.entries(SHARING_STATUS_LABELS);
const DIRECTION_OPTIONS = Object.entries(DIRECTION_LABELS);

/**
 * Filters of the trips list as a GET form: the URL stays shareable and the page needs no JavaScript.
 * `patientLabel`: the patient a link from the planning filtered on (?patient=, by id), shown as a removable chip.
 */
export function TripFiltersForm({ date, filters, patientLabel = null }: { date: string; filters: TripFilters; patientLabel?: string | null }) {
  return (
    <form action="/courses" method="get" role="search" aria-label="Filtrer les courses" className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="date" value={date} />
      {filters.patient ? (
        <div className="space-y-1">
          <input type="hidden" name="patient" value={filters.patient} />
          <span className="block text-xs font-medium text-slate-600">Patient choisi</span>
          <span className="inline-flex h-10 items-center gap-1.5 rounded-md border border-brand-200 bg-brand-50 pl-2.5 pr-1 text-sm text-brand-900">
            {patientLabel ?? "Aucune course ce jour"}
            <Link
              href={coursesHref(date, { ...filters, patient: null })}
              aria-label="Retirer le filtre sur ce patient"
              title="Retirer le filtre sur ce patient"
              className="grid size-6 place-items-center rounded text-brand-700 hover:bg-brand-100 focus-visible:outline-2 focus-visible:outline-brand-600"
            >
              <X aria-hidden className="size-3.5" />
            </Link>
          </span>
        </div>
      ) : null}
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
          <option value="RETURN_TO_CHECK">Retours à vérifier (aller absent)</option>
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
