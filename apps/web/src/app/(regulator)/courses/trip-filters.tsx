import Link from "next/link";
import { X } from "lucide-react";
import type { VehicleType } from "@prisma/client";
import { FilterBar, FilterSearch, FilterSelect, type FilterOptionGroup } from "@/components/ui/filter-bar";
import { DIRECTION_LABELS, PAYER_LABELS, SHARING_STATUS_LABELS, TRIP_STATUS_LABELS } from "@/lib/labels";
import { coursesHref, hasActiveFilters, NO_FACILITY, UNASSIGNED, type TripFilters } from "./trip-list";

const STATUS_OPTIONS = Object.entries(TRIP_STATUS_LABELS).map(([value, label]) => ({ value, label }));
const SHARING_OPTIONS = Object.entries(SHARING_STATUS_LABELS).map(([value, label]) => ({ value, label }));
const DIRECTION_OPTIONS = Object.entries(DIRECTION_LABELS).map(([value, label]) => ({ value, label }));
const PAYER_OPTIONS = [
  { value: "CPAM", label: "CPAM" },
  { value: "PRIVATE", label: PAYER_LABELS.PRIVATE },
];

/** What the lists of the bar offer: the facilities and vehicles of the day, every depot. */
export type TripFilterChoices = {
  facilities: { id: string; name: string }[];
  /** Vehicles with a route that day, by depot, in the usual order. */
  vehicles: { id: string; label: string; type: VehicleType; depotName: string }[];
  depots: { id: string; name: string }[];
};

/**
 * Filters of the trips list (FilterBar: a list applies at once, the search
 * on Entrée; the server filters the day). `patientLabel`: the patient a link
 * from the planning filtered on (?patient=, by id), shown as a removable chip.
 */
export function TripFiltersForm({
  date,
  filters,
  choices,
  patientLabel = null,
}: {
  date: string;
  filters: TripFilters;
  choices: TripFilterChoices;
  patientLabel?: string | null;
}) {
  // The vehicles of the day by depot, in the order of the planning.
  const byDepot = new Map<string, { value: string; label: string }[]>();
  for (const vehicle of choices.vehicles) {
    const options = byDepot.get(vehicle.depotName) ?? [];
    options.push({ value: vehicle.id, label: vehicle.label });
    byDepot.set(vehicle.depotName, options);
  }
  const vehicleGroups: FilterOptionGroup[] = [...byDepot].map(([depot, options]) => ({ group: `Dépôt ${depot}`, options }));
  return (
    <FilterBar
      action="/courses"
      label="Filtrer les courses"
      resetHref={coursesHref(date)}
      filtered={hasActiveFilters(filters)}
      hidden={filters.patient ? { date, patient: filters.patient } : { date }}
    >
      {filters.patient ? (
        <div className="space-y-1">
          <span className="block text-xs font-medium text-slate-600">Patient choisi</span>
          <span className="inline-flex h-10 items-center gap-1.5 rounded-md border border-brand-200 bg-brand-50 pr-1 pl-2.5 text-sm text-brand-900">
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
      <FilterSearch defaultValue={filters.q} placeholder="Patient, établissement, ville" className="sm:w-56" />
      <FilterSelect
        name="statut"
        label="Statut"
        value={filters.status ?? ""}
        allLabel="Tous"
        options={[
          { value: "ACTIVE", label: "Hors annulées" },
          { value: "RETURN_TO_CHECK", label: "Retours à vérifier (aller absent)" },
          ...STATUS_OPTIONS,
        ]}
        className="w-40"
      />
      <FilterSelect name="sens" label="Sens" value={filters.direction ?? ""} allLabel="Tous" options={DIRECTION_OPTIONS} className="w-28" />
      <FilterSelect
        name="partage"
        label="Partage"
        value={filters.sharing ?? ""}
        allLabel="Tous"
        options={[{ value: "SHARED", label: "Partagées dans le planning" }, ...SHARING_OPTIONS]}
        className="w-40"
      />
      <FilterSelect
        name="etablissement"
        label="Établissement"
        value={filters.facility ?? ""}
        allLabel="Tous"
        options={[...choices.facilities.map((f) => ({ value: f.id, label: f.name })), { value: NO_FACILITY, label: "Adresse libre" }]}
        className="w-48"
      />
      <FilterSelect
        name="vehicule"
        label="Véhicule"
        value={filters.vehicle ?? ""}
        allLabel="Tous"
        options={[{ value: UNASSIGNED, label: "Non affectées" }, ...vehicleGroups]}
        className="w-40"
      />
      <FilterSelect
        name="depot"
        label="Dépôt du véhicule"
        value={filters.depot ?? ""}
        allLabel="Tous"
        options={choices.depots.map((d) => ({ value: d.id, label: d.name }))}
        className="w-40"
      />
      <FilterSelect name="payeur" label="Payeur" value={filters.payer ?? ""} allLabel="Tous" options={PAYER_OPTIONS} className="w-36" />
      <FilterSelect
        name="origine"
        label="Origine"
        value={filters.origin ?? ""}
        allLabel="Toutes"
        options={[
          { value: "reguliere", label: "Régulières (série)" },
          { value: "ponctuelle", label: "Ponctuelles" },
        ]}
        className="w-36"
      />
    </FilterBar>
  );
}
