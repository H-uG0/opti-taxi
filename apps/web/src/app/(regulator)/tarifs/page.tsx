import type { Metadata } from "next";
import Link from "next/link";
import { Copy, Plus } from "lucide-react";
import type { TariffGrid } from "@prisma/client";
import { Badge, VehicleTypeBadge, type BadgeTone } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui/layout";
import { TBody, THead, Table, Td, Th } from "@/components/ui/table";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { tariffCoverageAlerts, tariffsInForce } from "@/lib/domain/tariffs";
import { formatEuros, formatKm, formatPercent, VEHICLE_TYPE_LABELS, VEHICLE_TYPE_SHORT } from "@/lib/labels";
import { addDays, formatLongDate, formatShortDate, todayIso, tomorrowIso, toIsoDate } from "@/lib/time";
import { ALL_ZONES, departmentLabel } from "../vehicules/_lib/departments";
import { Callout } from "../vehicules/_lib/ui";
import { COVERAGE_DAYS, coverageAlertText } from "./coverage";
import { FareSimulator, type SimulatorGrid } from "./fare-simulator";
import { TARIFF_STATUS_LABELS, tariffStatus, VEHICLE_TYPES, type TariffStatus } from "./schema";

export const metadata: Metadata = { title: "Grilles tarifaires" };

const STATUS_TONES: Record<TariffStatus, BadgeTone> = {
  IN_FORCE: "success",
  UPCOMING: "info",
  EXPIRED: "neutral",
  SUPERSEDED: "warning",
};

/** Specific departments in code order, the "*" catch-all last. */
function compareDepartments(a: string, b: string): number {
  if (a === b) return 0;
  if (a === ALL_ZONES) return 1;
  if (b === ALL_ZONES) return -1;
  return a.localeCompare(b, "fr", { numeric: true });
}

function groupByDepartment(grids: TariffGrid[]): [string, TariffGrid[]][] {
  const groups = new Map<string, TariffGrid[]>();
  for (const grid of grids) {
    const list = groups.get(grid.department) ?? [];
    list.push(grid);
    groups.set(grid.department, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => compareDepartments(a, b))
    .map(([department, list]) => [department, list.sort((x, y) => y.validFrom.getTime() - x.validFrom.getTime())]);
}

function validityText(grid: TariffGrid): string {
  const from = formatShortDate(toIsoDate(grid.validFrom));
  return grid.validTo ? `du ${from} au ${formatShortDate(toIsoDate(grid.validTo))}` : `depuis le ${from}`;
}

export default async function TariffsPage() {
  await requireUser("REGULATOR");
  const today = todayIso();

  const [grids, vehicles] = await Promise.all([
    db.tariffGrid.findMany({ orderBy: [{ vehicleType: "asc" }, { department: "asc" }, { validFrom: "desc" }] }),
    db.vehicle.findMany({
      where: { active: true },
      select: { id: true, label: true, type: true, department: true },
      orderBy: { label: "asc" },
    }),
  ]);

  const inForce = tariffsInForce(grids, today);
  const inForceIds = new Set(inForce.map((g) => g.id));

  // The planning works on tomorrow and the next days: a grid ending today leaves tomorrow at 0 €.
  const tomorrow = tomorrowIso();
  const coverageEnd = addDays(tomorrow, COVERAGE_DAYS);
  const coverage = tariffCoverageAlerts(vehicles, grids, tomorrow, COVERAGE_DAYS);

  const simulatorGrids: SimulatorGrid[] = grids.map((g) => ({
    id: g.id,
    name: `${VEHICLE_TYPE_SHORT[g.vehicleType]} · ${departmentLabel(g.department)}${g.label ? ` · ${g.label}` : ""} (${TARIFF_STATUS_LABELS[tariffStatus(g, today, inForceIds)].toLowerCase()})`,
    baseFare: g.baseFare,
    pricePerKm: g.pricePerKm,
    includedKm: g.includedKm,
    sharedDiscount2: g.sharedDiscount2,
    sharedDiscount3: g.sharedDiscount3,
  }));

  return (
    <>
      <PageHeader
        title="Grilles tarifaires"
        description={`Tarifs par type de véhicule et département, servant au chiffre d'affaires estimé des tournées. Situation au ${formatLongDate(today)}.`}
        actions={
          <LinkButton href="/tarifs/nouveau" variant="primary">
            <Plus aria-hidden className="size-4" />
            Nouvelle grille
          </LinkButton>
        }
      />

      <div className="mb-6 space-y-3">
        <Callout title="Des données, pas du code">
          <p>
            Les montants changent avec la convention-cadre des taxis et les avenants des transporteurs sanitaires, et
            varient selon le département : ils se saisissent donc ici et ne sont jamais écrits dans le code.
          </p>
          <p>
            Pour un nouvel avenant, <strong>dupliquez</strong> la grille et indiquez sa date d&apos;effet plutôt que de
            modifier l&apos;ancienne : l&apos;historique reste juste. Quand plusieurs grilles se chevauchent, la plus
            récente l&apos;emporte ; la grille « * » sert de repli pour les départements sans grille propre.
          </p>
        </Callout>

        {coverage.length > 0 ? (
          <Callout
            tone="warning"
            title={`Véhicules sans grille en vigueur entre le ${formatShortDate(tomorrow)} et le ${formatShortDate(coverageEnd)}`}
          >
            <p>Ces jours-là, l&apos;optimiseur estimera leur chiffre d&apos;affaires à 0 € :</p>
            <ul className="list-disc space-y-1 pl-5">
              {coverage.map((alert) => (
                <li key={`${alert.vehicleType}/${alert.department}`}>
                  <span className="font-medium">
                    {VEHICLE_TYPE_SHORT[alert.vehicleType]} · {departmentLabel(alert.department)}
                  </span>{" "}
                  — {alert.vehicles.join(", ")}
                  <span className="block">{coverageAlertText(alert)}</span>
                </li>
              ))}
            </ul>
            <p>Créez la grille qui prend le relais (« Dupliquer » sur la grille actuelle, puis sa date d&apos;effet).</p>
          </Callout>
        ) : null}
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-8">
          {grids.length === 0 ? (
            <EmptyState
              title="Aucune grille tarifaire"
              action={
                <LinkButton href="/tarifs/nouveau" variant="primary">
                  Créer une grille
                </LinkButton>
              }
            >
              Sans grille, l&apos;optimiseur ne peut pas estimer le chiffre d&apos;affaires des courses.
            </EmptyState>
          ) : (
            VEHICLE_TYPES.map((type) => {
              const ofType = grids.filter((g) => g.vehicleType === type);
              if (ofType.length === 0) return null;
              return (
                <section key={type} aria-labelledby={`tarifs-${type}`} className="space-y-2">
                  <h2 id={`tarifs-${type}`} className="flex items-center gap-2 text-base font-semibold text-slate-900">
                    <VehicleTypeBadge type={type} />
                    {VEHICLE_TYPE_LABELS[type]}
                    <span className="text-sm font-normal text-slate-500">
                      · {ofType.length} grille{ofType.length > 1 ? "s" : ""}
                    </span>
                  </h2>
                  <Table>
                    <THead>
                      <tr>
                        <Th>Libellé</Th>
                        <Th className="text-right">Forfait</Th>
                        <Th className="text-right">Prix/km</Th>
                        <Th className="text-right">Km inclus</Th>
                        <Th className="text-right">Partage 2 / 3</Th>
                        <Th>Validité</Th>
                        <Th>Statut</Th>
                        <Th>
                          <span className="sr-only">Actions</span>
                        </Th>
                      </tr>
                    </THead>
                    {groupByDepartment(ofType).map(([department, list]) => (
                      <TBody key={department}>
                        <tr className="bg-slate-50/70">
                          <th
                            scope="rowgroup"
                            colSpan={8}
                            className="px-3 py-1.5 text-left text-xs font-semibold text-slate-600"
                          >
                            {departmentLabel(department)}
                          </th>
                        </tr>
                        {list.map((grid) => {
                          const status = tariffStatus(grid, today, inForceIds);
                          return (
                            <tr key={grid.id} className={status === "IN_FORCE" ? "hover:bg-slate-50" : "text-slate-500 hover:bg-slate-50"}>
                              <Td className="max-w-64">
                                <Link
                                  href={`/tarifs/${grid.id}`}
                                  className="block truncate font-medium text-slate-900 underline-offset-2 hover:text-brand-700 hover:underline"
                                  title={grid.notes ?? undefined}
                                >
                                  {grid.label ?? "Sans libellé"}
                                </Link>
                              </Td>
                              <Td className="tabular text-right whitespace-nowrap">{formatEuros(grid.baseFare)}</Td>
                              <Td className="tabular text-right whitespace-nowrap">{formatEuros(grid.pricePerKm)}</Td>
                              <Td className="tabular text-right whitespace-nowrap">
                                {grid.includedKm > 0 ? formatKm(grid.includedKm, 0) : "—"}
                              </Td>
                              <Td className="tabular text-right whitespace-nowrap">
                                {formatPercent(grid.sharedDiscount2, 1)} / {formatPercent(grid.sharedDiscount3, 1)}
                              </Td>
                              <Td className="tabular text-xs whitespace-nowrap">{validityText(grid)}</Td>
                              <Td>
                                <Badge tone={STATUS_TONES[status]}>{TARIFF_STATUS_LABELS[status]}</Badge>
                              </Td>
                              <Td className="text-right whitespace-nowrap">
                                <LinkButton
                                  href={`/tarifs/nouveau?depuis=${grid.id}`}
                                  size="sm"
                                  variant="ghost"
                                  title="Créer une nouvelle version à partir de cette grille"
                                  aria-label={`Dupliquer la grille ${grid.label ?? departmentLabel(grid.department)}`}
                                >
                                  <Copy aria-hidden className="size-3.5" />
                                  Dupliquer
                                </LinkButton>
                                <LinkButton
                                  href={`/tarifs/${grid.id}`}
                                  size="sm"
                                  variant="ghost"
                                  aria-label={`Modifier la grille ${grid.label ?? departmentLabel(grid.department)}`}
                                >
                                  Modifier
                                </LinkButton>
                              </Td>
                            </tr>
                          );
                        })}
                      </TBody>
                    ))}
                  </Table>
                </section>
              );
            })
          )}
        </div>

        <Card className="xl:sticky xl:top-[calc(1.5rem+var(--demo-banner-h))]">
          <CardHeader title="Simulateur" />
          <CardBody>
            <FareSimulator grids={simulatorGrids} defaultGridId={inForce[0]?.id ?? null} />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
