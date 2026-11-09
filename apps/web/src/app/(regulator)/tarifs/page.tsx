import type { Metadata } from "next";
import Link from "next/link";
import { Copy, ExternalLink, Plus, Settings2 } from "lucide-react";
import type { TariffGrid } from "@prisma/client";
import { Badge, VehicleTypeBadge, type BadgeTone } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui/layout";
import { TBody, THead, Table, Td, Th } from "@/components/ui/table";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { companyStatusOn, readSharedDiscounts, tariffCoverageAlerts, tariffsInForce, toFareGrid } from "@/lib/domain/tariffs";
import { formatEuros, formatKm, formatPercent, VEHICLE_TYPE_LABELS, VEHICLE_TYPE_SHORT } from "@/lib/labels";
import { addDays, formatLongDate, formatShortDate, todayIso, tomorrowIso, toIsoDate } from "@/lib/time";
import { ALL_ZONES, departmentLabel } from "../vehicules/_lib/departments";
import { Callout } from "../vehicules/_lib/ui";
import { EMPTY_LEG_SHORT, PATIENT_COUNT_SHORT } from "./billing-labels";
import { COVERAGE_DAYS, coverageAlertText } from "./coverage";
import { FareSimulator, type SimulatorGrid } from "./fare-simulator";
import {
  TARIFF_STATUS_LABELS,
  tariffStatus,
  VEHICLE_TYPES,
  VERIFICATION_LABELS,
  VERIFICATION_TONES,
  type TariffStatus,
} from "./schema";

export const metadata: Metadata = { title: "Grilles tarifaires" };

const STATUS_TONES: Record<TariffStatus, BadgeTone> = {
  IN_FORCE: "success",
  UPCOMING: "info",
  EXPIRED: "neutral",
  SUPERSEDED: "warning",
};

/** Specific departments in code order, the "*" catch-all last; certified before non-certified. */
function compareScopes(a: [string, boolean | null], b: [string, boolean | null]): number {
  if (a[0] !== b[0]) {
    if (a[0] === ALL_ZONES) return 1;
    if (b[0] === ALL_ZONES) return -1;
    return a[0].localeCompare(b[0], "fr", { numeric: true });
  }
  const rank = (c: boolean | null) => (c === true ? 0 : c === false ? 1 : 2);
  return rank(a[1]) - rank(b[1]);
}

function groupByScope(grids: TariffGrid[]): { department: string; certified: boolean | null; grids: TariffGrid[] }[] {
  const groups = new Map<string, { department: string; certified: boolean | null; grids: TariffGrid[] }>();
  for (const grid of grids) {
    const key = `${grid.department}/${grid.certified}`;
    const group = groups.get(key) ?? { department: grid.department, certified: grid.certified, grids: [] };
    group.grids.push(grid);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => compareScopes([a.department, a.certified], [b.department, b.certified]))
    .map((group) => ({ ...group, grids: group.grids.sort((x, y) => y.validFrom.getTime() - x.validFrom.getTime()) }));
}

function validityText(grid: Pick<TariffGrid, "validFrom" | "validTo">): string {
  const from = formatShortDate(toIsoDate(grid.validFrom));
  return grid.validTo ? `du ${from} au ${formatShortDate(toIsoDate(grid.validTo))}` : `depuis le ${from}`;
}

function scopeTitle(department: string, certified: boolean | null): string {
  const place = departmentLabel(department);
  return certified === null ? place : `${place} · entreprise ${certified ? "certifiée" : "non certifiée"}`;
}

function surchargeText(grid: TariffGrid): string {
  if (grid.nightRate === 0 && grid.weekendRate === 0) return "—";
  return `${formatPercent(grid.nightRate)} / ${formatPercent(grid.weekendRate)}`;
}

function sharingText(grid: TariffGrid): string {
  const discounts = readSharedDiscounts(grid.sharedDiscounts);
  if (discounts.length === 0) return "—";
  // « 23 / 35 / 37 % »: one percent sign for the row.
  return `${discounts.map((d) => formatPercent(d.rate).replace(/\s*%$/, "")).join(" / ")} %`;
}

export default async function TariffsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("REGULATOR");
  const today = todayIso();
  const showExpired = (await searchParams).expirees === "1";

  const [grids, vehicles, certifications, settings] = await Promise.all([
    db.tariffGrid.findMany({ orderBy: [{ vehicleType: "asc" }, { department: "asc" }, { validFrom: "desc" }] }),
    db.vehicle.findMany({
      where: { active: true },
      select: { id: true, label: true, type: true, department: true },
      orderBy: { label: "asc" },
    }),
    db.companyCertification.findMany({ select: { validFrom: true, validTo: true }, orderBy: { validFrom: "asc" } }),
    db.appSettings.findUnique({
      where: { id: 1 },
      select: { hqDepartment: true, hqCity: true, emptyLegRule: true, sharedPatientCount: true },
    }),
  ]);
  const company = { certifications, hqDepartment: settings?.hqDepartment ?? null };

  const inForce = tariffsInForce(grids, today);
  const inForceIds = new Set(inForce.map((g) => g.id));
  const expiredCount = grids.filter((g) => tariffStatus(g, today, inForceIds) === "EXPIRED").length;
  const shown = showExpired ? grids : grids.filter((g) => tariffStatus(g, today, inForceIds) !== "EXPIRED");

  // The planning works on tomorrow and the next days: a grid ending today leaves tomorrow at 0 €.
  const tomorrow = tomorrowIso();
  const coverageEnd = addDays(tomorrow, COVERAGE_DAYS);
  const coverage = tariffCoverageAlerts(vehicles, grids, tomorrow, COVERAGE_DAYS, company);
  const certifiedTomorrow = companyStatusOn(company, tomorrow).certified;
  const currentPeriod = certifications.find(
    (p) => toIsoDate(p.validFrom) <= tomorrow && (p.validTo === null || toIsoDate(p.validTo) >= tomorrow),
  );

  const simulatorGrids: SimulatorGrid[] = grids
    .filter((g) => inForceIds.has(g.id) || tariffStatus(g, today, inForceIds) === "UPCOMING")
    .map((g) => ({
      ...toFareGrid(g),
      id: g.id,
      name: `${g.label ?? `${VEHICLE_TYPE_SHORT[g.vehicleType]} · ${departmentLabel(g.department)}`} (${TARIFF_STATUS_LABELS[tariffStatus(g, today, inForceIds)].toLowerCase()})`,
    }));

  return (
    <>
      <PageHeader
        title="Grilles tarifaires"
        description={`Tarifs conventionnels par type de véhicule, servant au chiffre d'affaires estimé des tournées. Situation au ${formatLongDate(today)}.`}
        actions={
          <>
            <LinkButton href="/tarifs/regles" variant="secondary">
              <Settings2 aria-hidden className="size-4" />
              Règles de facturation
            </LinkButton>
            <LinkButton href="/tarifs/nouveau" variant="primary">
              <Plus aria-hidden className="size-4" />
              Nouvelle grille
            </LinkButton>
          </>
        }
      />

      <div className="mb-6 space-y-3">
        <Callout title="Facturation de l'entreprise">
          <p>
            {certifiedTomorrow ? (
              <>
                <strong>Entreprise certifiée</strong>
                {currentPeriod ? ` depuis le ${formatShortDate(toIsoDate(currentPeriod.validFrom))}` : ""} (géolocalisation certifiée et
                SEFi) : VSL et ambulances aux grilles majorées.
              </>
            ) : (
              <>
                <strong>Entreprise non certifiée</strong> demain : VSL et ambulances aux grilles socle.
              </>
            )}{" "}
            Siège : {settings?.hqCity ? `${settings.hqCity} (${settings.hqDepartment ?? "?"})` : "non renseigné"}. Taxis : grille du
            département de leur ADS. Lecture retenue : {EMPTY_LEG_SHORT[settings?.emptyLegRule ?? "DEPOT"]}, abattement selon les{" "}
            {PATIENT_COUNT_SHORT[settings?.sharedPatientCount ?? "DISTINCT"]}.{" "}
            <Link href="/tarifs/regles" className="font-medium underline underline-offset-2">
              Modifier les règles de facturation
            </Link>
          </p>
          <p>
            Les montants changent avec la convention des taxis et les avenants des transporteurs sanitaires : ils se saisissent ici,
            jamais dans le code. Pour un nouvel avenant, <strong>dupliquez</strong> la grille et indiquez sa date d&apos;effet.
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
            <p>
              Créez la grille qui prend le relais (« Dupliquer » sur la grille actuelle, puis sa date d&apos;effet), ou vérifiez la
              certification et le siège dans les règles de facturation.
            </p>
          </Callout>
        ) : null}
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-8">
          {expiredCount > 0 ? (
            <p className="text-sm text-slate-600">
              {showExpired ? (
                <Link href="/tarifs" className="text-brand-700 underline underline-offset-2">
                  Masquer les grilles expirées
                </Link>
              ) : (
                <Link href="/tarifs?expirees=1" className="text-brand-700 underline underline-offset-2">
                  Afficher les {expiredCount} grilles expirées (historique)
                </Link>
              )}
            </p>
          ) : null}
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
              const ofType = shown.filter((g) => g.vehicleType === type);
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
                        <Th>Libellé, validité et source</Th>
                        <Th className="text-right">Forfait</Th>
                        <Th className="text-right">Kilomètre</Th>
                        <Th className="text-right" title="Majoration de nuit / dimanche et jour férié">
                          Nuit / férié
                        </Th>
                        <Th className="text-right" title="Abattement à 2, 3, 4 patients et plus">
                          Partage
                        </Th>
                        <Th>
                          <span className="sr-only">Actions</span>
                        </Th>
                      </tr>
                    </THead>
                    {groupByScope(ofType).map(({ department, certified, grids: list }) => (
                      <TBody key={`${department}/${certified}`}>
                        <tr className="bg-slate-50/70">
                          <th scope="rowgroup" colSpan={6} className="px-3 py-1.5 text-left text-xs font-semibold text-slate-600">
                            {scopeTitle(department, certified)}
                          </th>
                        </tr>
                        {list.map((grid) => {
                          const status = tariffStatus(grid, today, inForceIds);
                          const extras = [
                            grid.bigCityFare > 0 ? `+${formatEuros(grid.bigCityFare)} grande ville` : null,
                            grid.aggloFare !== null ? `agglo. ${formatEuros(grid.aggloFare)}` : null,
                          ].filter(Boolean);
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
                                <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                                  <Badge tone={STATUS_TONES[status]}>{TARIFF_STATUS_LABELS[status]}</Badge>
                                  <span className="tabular text-slate-500">{validityText(grid)}</span>
                                  <Badge tone={VERIFICATION_TONES[grid.verification]}>{VERIFICATION_LABELS[grid.verification]}</Badge>
                                  {grid.sourceUrl ? (
                                    <a
                                      href={grid.sourceUrl}
                                      target="_blank"
                                      rel="noreferrer noopener"
                                      className="inline-flex items-center gap-0.5 text-slate-500 underline-offset-2 hover:text-brand-700 hover:underline"
                                    >
                                      source
                                      <ExternalLink aria-hidden className="size-3" />
                                    </a>
                                  ) : null}
                                </span>
                              </Td>
                              <Td className="tabular text-right">
                                <span className="whitespace-nowrap">{formatEuros(grid.baseFare)}</span>
                                {extras.map((extra) => (
                                  <span key={extra} className="block text-xs text-slate-500">
                                    {extra}
                                  </span>
                                ))}
                              </Td>
                              <Td className="tabular text-right whitespace-nowrap">
                                {formatEuros(grid.pricePerKm)}
                                <span className="block text-xs text-slate-500">
                                  {grid.includedKm > 0 ? `${formatKm(grid.includedKm, 0)} inclus` : "dès le 1er km"}
                                </span>
                              </Td>
                              <Td className="tabular text-right whitespace-nowrap">{surchargeText(grid)}</Td>
                              <Td className="tabular text-right whitespace-nowrap">
                                {sharingText(grid)}
                                <span className="block text-xs text-slate-500">
                                  {grid.maxSharedPatients > 1 ? `${grid.maxSharedPatients} patients max.` : "pas de partage"}
                                </span>
                              </Td>
                              <Td className="w-10 text-right">
                                <LinkButton
                                  href={`/tarifs/nouveau?depuis=${grid.id}`}
                                  size="sm"
                                  variant="ghost"
                                  title="Dupliquer : nouvelle version datée de cette grille"
                                  aria-label={`Dupliquer la grille ${grid.label ?? departmentLabel(grid.department)}`}
                                >
                                  <Copy aria-hidden className="size-3.5" />
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
            <FareSimulator
              grids={simulatorGrids}
              defaultGridId={
                inForce.find((g) => g.vehicleType === "TAXI" && g.department === settings?.hqDepartment)?.id ??
                inForce.find((g) => g.vehicleType === "TAXI")?.id ??
                inForce[0]?.id ??
                null
              }
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
