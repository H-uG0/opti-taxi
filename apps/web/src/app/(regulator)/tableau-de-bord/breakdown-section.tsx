import type { VehicleType } from "@prisma/client";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { Table, TBody, THead } from "@/components/ui/table";
import {
  crewOf,
  fleetDaysBy,
  groupLines,
  lineRates,
  plannedBy,
  sumLines,
  usedVehiclesByDate,
  type FleetDays,
  type LineTotals,
  type RouteLine,
} from "@/lib/kpis-breakdown";
import type { KpiFleetDay, KpiFrozenPlan } from "@/lib/kpis-rows";
import { inScope, type KpiScope } from "@/lib/kpis-scope";
import { formatKm, formatPercent, VEHICLE_TYPE_LABELS, VEHICLE_TYPE_SHORT } from "@/lib/labels";
import { formatPersonName } from "@/lib/names";
import { formatDecimal, formatEurosRounded } from "./format";
import { BREAKDOWN_AXES, dashboardHref, type BreakdownAxis, type HrefState } from "./query";

type Row = {
  key: string;
  label: string;
  href: string;
  /** What the link does, for its title. */
  linkTitle: string;
  sub?: string;
  totals: LineTotals;
  fleet?: FleetDays;
  planned?: { trips: number; vehicles: number };
};

type Column = {
  key: string;
  label: string;
  title?: string;
  /** Sort value (text columns sort ascending first, numbers descending first). */
  value: (row: Row) => number | string | null;
  render: (row: Row) => ReactNode;
  divider?: boolean;
  numeric?: boolean;
};

const ZERO = sumLines([]);

const num = (value: number | null, digits = 1) => (value === null ? "—" : formatDecimal(value, digits));

/** Columns shared by the axes; each axis picks its own. */
const COLUMNS: Record<string, Column> = {
  name: { key: "nom", label: "", value: (r) => r.label, render: () => null },
  vehicleDays: {
    key: "jours",
    label: "Véh.-jours",
    title: "Journées-véhicules utilisées / disponibles (ni indisponibles ni sans équipage)",
    value: (r) => r.totals.vehicleDays,
    render: (r) => (r.fleet ? `${r.totals.vehicleDays} / ${r.fleet.available}` : r.totals.vehicleDays),
    numeric: true,
  },
  days: { key: "jours", label: "Jours", title: "Jours avec une tournée", value: (r) => r.totals.days, render: (r) => r.totals.days, numeric: true },
  trips: { key: "courses", label: "Courses", value: (r) => r.totals.trips, render: (r) => r.totals.trips, numeric: true, divider: true },
  tripsPerVehicle: {
    key: "parvehicule",
    label: "Courses / véh.",
    title: "Courses servies par journée-véhicule utilisée",
    value: (r) => lineRates(r.totals).tripsPerVehicleDay,
    render: (r) => num(lineRates(r.totals).tripsPerVehicleDay),
    numeric: true,
  },
  planned: {
    key: "prevu",
    label: "Prévu",
    title: "Courses par véhicule du plan validé (figé à la validation) des jours commencés, des tournées prévues sinon",
    value: (r) => (r.planned && r.planned.vehicles > 0 ? r.planned.trips / r.planned.vehicles : null),
    render: (r) => num(r.planned && r.planned.vehicles > 0 ? r.planned.trips / r.planned.vehicles : null),
    numeric: true,
  },
  km: { key: "km", label: "Km", value: (r) => r.totals.distanceKm, render: (r) => formatKm(r.totals.distanceKm, 0), numeric: true, divider: true },
  empty: {
    key: "vide",
    label: "Km à vide",
    value: (r) => lineRates(r.totals).emptyKmShare,
    render: (r) => formatPercent(lineRates(r.totals).emptyKmShare, 1),
    numeric: true,
  },
  shared: {
    key: "partage",
    label: "Partagé",
    title: "Courses partagées ÷ courses éligibles (CPAM, taxi ou VSL)",
    value: (r) => lineRates(r.totals).sharedRate,
    render: (r) => formatPercent(lineRates(r.totals).sharedRate, 1),
    numeric: true,
    divider: true,
  },
  late: {
    key: "retards",
    label: "Retards",
    title: "Allers en retard / allers déposés avec une heure saisie sur le moment",
    value: (r) => lineRates(r.totals).lateRate,
    render: (r) => (r.totals.measuredOutbound > 0 ? `${r.totals.lateArrivals} / ${r.totals.measuredOutbound}` : "—"),
    numeric: true,
    divider: true,
  },
  recording: {
    key: "saisie",
    label: "Saisie des statuts",
    title: "Courses dont l'équipage a saisi l'issue (déposé ou absent\u202f; une correction de la régulation ne compte pas) ÷ courses placées, jours terminés",
    value: (r) => lineRates(r.totals).recordingRate,
    render: (r) => formatPercent(lineRates(r.totals).recordingRate, 0),
    numeric: true,
  },
  hours: {
    key: "heures",
    label: "Heures planifiées",
    title: "Durée des tournées, pause déduite",
    value: (r) => r.totals.activeMinutes,
    render: (r) => `${formatDecimal(r.totals.activeMinutes / 60, 0)} h`,
    numeric: true,
    divider: true,
  },
  revenue: {
    key: "ca",
    label: "CA estimé",
    value: (r) => r.totals.revenue,
    render: (r) => formatEurosRounded(r.totals.revenue),
    numeric: true,
    divider: true,
  },
  margin: {
    key: "marge",
    label: "Marge",
    title: "CA estimé des courses servies − coût des tournées",
    value: (r) => r.totals.revenue - r.totals.cost,
    render: (r) => formatEurosRounded(r.totals.revenue - r.totals.cost),
    numeric: true,
  },
  marginPerTrip: {
    key: "margecourse",
    label: "Marge / course",
    value: (r) => lineRates(r.totals).marginPerTrip,
    render: (r) => formatEurosRounded(lineRates(r.totals).marginPerTrip),
    numeric: true,
  },
  lost: {
    key: "perdues",
    label: "Journées perdues",
    title: "Journées-véhicules indisponibles (entretien, réparation, garde…) ou sans équipage",
    value: (r) => (r.fleet ? r.fleet.unavailable + r.fleet.crewless : null),
    render: (r) => (r.fleet ? `${r.fleet.unavailable + r.fleet.crewless}` : "—"),
    numeric: true,
    divider: true,
  },
  offRoad: {
    key: "immobilise",
    label: "Immobilisé",
    title: "Journées d'indisponibilité (entretien, réparation, contrôle, garde…)",
    value: (r) => r.fleet?.unavailable ?? null,
    render: (r) => (r.fleet ? r.fleet.unavailable : "—"),
    numeric: true,
    divider: true,
  },
  crewless: {
    key: "sansequipage",
    label: "Sans équipage",
    title: "Journées disponible mais sans équipage (personne de libre, problème d'équipage, laissé au dépôt)",
    value: (r) => r.fleet?.crewless ?? null,
    render: (r) => (r.fleet ? r.fleet.crewless : "—"),
    numeric: true,
  },
};

const AXIS_COLUMNS: Record<BreakdownAxis, Column[]> = {
  depot: ["vehicleDays", "trips", "tripsPerVehicle", "planned", "km", "empty", "shared", "late", "revenue", "margin", "marginPerTrip", "lost"].map((k) => COLUMNS[k]!),
  type: ["vehicleDays", "trips", "tripsPerVehicle", "planned", "km", "empty", "shared", "late", "revenue", "margin", "marginPerTrip", "lost"].map((k) => COLUMNS[k]!),
  vehicule: ["days", "trips", "tripsPerVehicle", "km", "empty", "revenue", "margin", "marginPerTrip", "offRoad", "crewless"].map((k) => COLUMNS[k]!),
  chauffeur: ["days", "trips", "km", "late", "recording", "hours", "revenue", "margin"].map((k) => COLUMNS[k]!),
};

/** Default order: names for depots and types, the most trips first for a ranking of vehicles or people. */
const DEFAULT_SORT: Record<BreakdownAxis, string> = { depot: "nom", type: "nom", vehicule: "-courses", chauffeur: "-courses" };

const FIRST_HEADER: Record<BreakdownAxis, string> = { depot: "Dépôt", type: "Type", vehicule: "Véhicule", chauffeur: "Personne" };

function sortRows(rows: Row[], columns: Column[], sort: string): Row[] {
  const descending = sort.startsWith("-");
  const key = descending ? sort.slice(1) : sort;
  const column = key === "nom" ? COLUMNS.name : columns.find((c) => c.key === key);
  if (!column) return rows;
  return [...rows].sort((a, b) => {
    const va = column.value(a);
    const vb = column.value(b);
    // Unknown values last, whatever the direction.
    if (va === null && vb === null) return a.label.localeCompare(b.label, "fr");
    if (va === null) return 1;
    if (vb === null) return -1;
    const order = typeof va === "string" || typeof vb === "string" ? String(va).localeCompare(String(vb), "fr") : va - vb;
    return (descending ? -order : order) || a.label.localeCompare(b.label, "fr");
  });
}

/**
 * The period by depot, vehicle type, vehicle or person (KPI-02): the same
 * formulas as the dashboard on each group's routes. The depot and type filters
 * of the page narrow the lists; a depot or a type opens the whole dashboard
 * narrowed to it, a vehicle or a person opens its record (with its own
 * figures over 30 days).
 */
export function BreakdownSection({
  axis,
  sort,
  base,
  lines,
  fleet,
  plans,
  dates,
  today,
  scope,
  vehicles,
  depots,
  people,
}: {
  axis: BreakdownAxis;
  sort: string | null;
  base: HrefState;
  lines: readonly RouteLine[];
  fleet: readonly KpiFleetDay[];
  plans: readonly KpiFrozenPlan[];
  dates: readonly string[];
  today: string;
  scope: KpiScope;
  vehicles: readonly { id: string; label: string; type: VehicleType; depotId: string; active: boolean }[];
  depots: readonly { id: string; name: string }[];
  people: readonly { id: string; firstName: string; lastName: string; depotId: string | null }[];
}) {
  const depotName = new Map(depots.map((d) => [d.id, d.name]));
  const vehicle = new Map(vehicles.map((v) => [v.id, v]));
  const used = usedVehiclesByDate(lines);
  const columns = AXIS_COLUMNS[axis];
  let rows: Row[] = [];

  if (axis === "depot" || axis === "type") {
    const keyOfVehicle = (id: string) => {
      const v = vehicle.get(id);
      return v ? (axis === "depot" ? v.depotId : v.type) : null;
    };
    const totals = groupLines(lines, (line) => [axis === "depot" ? line.depotId : line.vehicleType]);
    const fleetDays = fleetDaysBy(fleet, used, keyOfVehicle);
    const planned = plannedBy(dates, plans, lines, today, (line) => (axis === "depot" ? line.depotId : line.vehicleType));
    const keys = new Set([...totals.keys(), ...fleetDays.keys()]);
    rows = [...keys].map((key) => ({
      key,
      label: axis === "depot" ? (depotName.get(key) ?? "Dépôt inconnu") : VEHICLE_TYPE_LABELS[key as VehicleType],
      href: dashboardHref({
        ...base,
        tab: "synthese",
        axis: null,
        sort: null,
        ...(axis === "depot" ? { depotId: key } : { vehicleType: key as VehicleType }),
      }),
      linkTitle: "Afficher tout le tableau de bord pour ce seul groupe",
      totals: totals.get(key) ?? ZERO,
      fleet: fleetDays.get(key),
      planned: planned.get(key),
    }));
  } else if (axis === "vehicule") {
    const totals = groupLines(lines, (line) => [line.vehicleId]);
    const fleetDays = fleetDaysBy(fleet, used, (id) => id);
    const ids = new Set([
      ...totals.keys(),
      ...vehicles.filter((v) => v.active && inScope(scope, v.depotId, v.type)).map((v) => v.id),
    ]);
    rows = [...ids].map((id) => {
      const v = vehicle.get(id);
      return {
        key: id,
        label: v?.label ?? "Véhicule supprimé",
        href: `/vehicules/${id}`,
        linkTitle: "Ouvrir la fiche du véhicule (ses chiffres sur 30 jours)",
        sub: v ? `${VEHICLE_TYPE_SHORT[v.type]} · ${depotName.get(v.depotId) ?? ""}` : undefined,
        totals: totals.get(id) ?? ZERO,
        fleet: fleetDays.get(id),
      };
    });
  } else {
    const totals = groupLines(lines, crewOf);
    const person = new Map(people.map((p) => [p.id, p]));
    rows = [...totals].map(([id, t]) => {
      const p = person.get(id);
      return {
        key: id,
        label: p ? formatPersonName(p) : "Personne supprimée",
        href: `/chauffeurs/${id}`,
        linkTitle: "Ouvrir la fiche (ses chiffres sur 30 jours)",
        sub: p?.depotId ? depotName.get(p.depotId) : undefined,
        totals: t,
      };
    });
  }

  const current = sort && (sort.replace(/^-/, "") === "nom" || columns.some((c) => c.key === sort.replace(/^-/, ""))) ? sort : DEFAULT_SORT[axis];
  const sorted = sortRows(rows, columns, current);
  const all = sumLines(lines);
  const allFleet = fleetDaysBy(fleet, used, () => "all").get("all");
  const headerLink = (key: string, numeric: boolean) => {
    const next = current === key || current === `-${key}` ? (current.startsWith("-") ? key : `-${key}`) : numeric ? `-${key}` : key;
    return dashboardHref({ ...base, sort: next });
  };
  const ariaSort = (key: string): "ascending" | "descending" | undefined =>
    current === key ? "ascending" : current === `-${key}` ? "descending" : undefined;

  return (
    <section aria-labelledby="breakdown-title" className="mb-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="breakdown-title" className="text-base font-semibold text-slate-900">
            Ventilation
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Les indicateurs de la période par groupe, calculés sur ses tournées comme pour toute l&apos;entreprise. Les filtres
            «&#x202F;Dépôt&#x202F;» et «&#x202F;Véhicules&#x202F;» en haut de page restreignent les listes. «&#x202F;Véh.-jours&#x202F;»&nbsp;:
            journées-véhicules utilisées / disponibles. Cliquez sur un en-tête pour trier.
          </p>
        </div>
        <nav aria-label="Ventiler par" className="flex flex-wrap gap-1">
          {BREAKDOWN_AXES.map((a) => (
            <Link
              key={a.id}
              href={dashboardHref({ ...base, axis: a.id, sort: null })}
              aria-current={a.id === axis ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-brand-600",
                a.id === axis ? "bg-brand-700 text-white" : "text-slate-700 hover:bg-slate-100",
              )}
            >
              {a.label}
            </Link>
          ))}
        </nav>
      </div>
      <Table stickyHeader>
        <caption className="sr-only">
          Indicateurs par {FIRST_HEADER[axis].toLowerCase()} sur la période, triés par la colonne marquée, et le total.
        </caption>
        <THead>
          <tr>
            <th scope="col" aria-sort={ariaSort("nom")} className="px-3 py-2 text-left text-xs font-semibold whitespace-nowrap text-slate-600 uppercase">
              <Link href={headerLink("nom", false)} className="hover:text-slate-900 hover:underline">
                {FIRST_HEADER[axis]}
              </Link>
            </th>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                aria-sort={ariaSort(column.key)}
                title={column.title}
                className={cn(
                  "px-2 py-2 text-right text-xs font-semibold whitespace-nowrap uppercase",
                  ariaSort(column.key) ? "text-slate-900" : "text-slate-600",
                  column.divider && "border-l border-slate-200",
                )}
              >
                <Link href={headerLink(column.key, column.numeric === true)} className="hover:text-slate-900 hover:underline">
                  {column.label}
                  {ariaSort(column.key) === "descending" ? " ↓" : ariaSort(column.key) === "ascending" ? " ↑" : ""}
                </Link>
              </th>
            ))}
          </tr>
        </THead>
        <TBody>
          {sorted.map((row) => (
            <tr key={row.key} className={row.totals.vehicleDays === 0 ? "bg-slate-50/60" : undefined}>
              <th scope="row" className="px-3 py-2 text-left font-normal whitespace-nowrap">
                <Link
                  href={row.href}
                  title={row.linkTitle}
                  className="font-medium text-slate-900 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
                >
                  {row.label}
                </Link>
                {row.sub ? <span className="block text-[11px] text-slate-600">{row.sub}</span> : null}
              </th>
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    "tabular px-2 py-2 text-right whitespace-nowrap",
                    column.key === "margecourse" && (lineRates(row.totals).marginPerTrip ?? 0) < 0 ? "text-red-700" : "text-slate-800",
                    column.divider && "border-l border-slate-100",
                  )}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </TBody>
        {axis !== "chauffeur" ? (
          <tfoot className="border-t-2 border-slate-200 bg-slate-50">
            <tr>
              <th scope="row" className="px-3 py-2 text-left font-semibold text-slate-900">
                Total
              </th>
              {columns.map((column) => (
                <td key={column.key} className={cn("tabular px-2 py-2 text-right font-semibold whitespace-nowrap text-slate-900", column.divider && "border-l border-slate-200")}>
                  {column.key === "prevu"
                    ? "—"
                    : column.render({ key: "all", label: "Total", href: "", linkTitle: "", totals: all, fleet: allFleet })}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </Table>
      {axis === "chauffeur" ? (
        <p className="mt-2 text-xs text-slate-600">
          Une personne compte les tournées qu&apos;elle a conduites ou dont elle était l&apos;équipier (ambulance)&nbsp;: les totaux ne
          s&apos;additionnent pas d&apos;une ligne à l&apos;autre.
        </p>
      ) : null}
    </section>
  );
}
