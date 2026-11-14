import type { Metadata } from "next";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/layout";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/domain/settings";
import { loadTrafficZones } from "@/lib/domain/traffic";
import { loadObservedCalibration } from "@/lib/domain/traffic-observed";
import { formatDateTime } from "@/lib/time";
import { applyObservedTraffic, saveKpiTargets, saveSettings, saveTraffic } from "./actions";
import { TargetsForm } from "./targets-form";
import { targetsFormValues } from "./targets-schema";
import { settingsFormValues } from "./schema";
import { SettingsForm } from "./settings-form";
import { TrafficForm } from "./traffic-form";
import { trafficFormValues } from "./traffic-schema";

export const metadata: Metadata = { title: "Paramètres" };


export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireUser("REGULATOR");
  const { objectifs } = await searchParams;
  const [settings, zones, depots, targets] = await Promise.all([
    getSettings(db),
    loadTrafficZones(db),
    db.depot.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.kpiTarget.findMany({ select: { indicator: true, depotId: true, reference: true, objective: true } }),
  ]);
  const calibration = await loadObservedCalibration(db, settings, zones);
  const requested = Array.isArray(objectifs) ? objectifs[0] : objectifs;
  const depot = depots.find((d) => d.id === requested) ?? null;

  return (
    <div className="max-w-5xl space-y-8">
      <PageHeader
        title="Paramètres"
        description={`Règles appliquées à chaque calcul des tournées et numéro de la régulation affiché aux chauffeurs. Dernière modification le ${formatDateTime(settings.updatedAt)}.`}
      />
      <SettingsForm action={saveSettings} initial={settingsFormValues(settings)} />
      <TrafficForm
        action={saveTraffic}
        applyObserved={applyObservedTraffic}
        initial={trafficFormValues(settings, zones)}
        zones={zones.map((zone) => ({ id: zone.id, name: zone.name, hasRadius: zone.radiusKm !== null }))}
        observed={calibration.factors}
        calibration={{ source: calibration.source, otherSourceRoutes: calibration.otherSourceRoutes }}
      />
      <Card id="objectifs" className="scroll-mt-4">
        <CardHeader title="Objectifs du tableau de bord" />
        <CardBody className="space-y-4">
          <p className="max-w-3xl text-sm text-slate-600">
            Pour chaque indicateur, la valeur de référence (mesurée sur l&apos;historique de V, avant l&apos;outil) et l&apos;objectif
            visé&nbsp;: le tableau de bord les trace en pointillés sur ses graphiques et affiche l&apos;écart dans ses tuiles. Les valeurs
            sont à fournir par V. Un dépôt sans valeur propre reprend celle de l&apos;entreprise&nbsp;; sans objectif saisi, le partage
            vise les 30&nbsp;% du protocole de 2025 (fin 2027).
          </p>
          <nav aria-label="Portée des objectifs" className="flex flex-wrap gap-1">
            {[{ id: null, name: "Toute l'entreprise" }, ...depots].map((scope) => {
              const active = (depot?.id ?? null) === scope.id;
              return (
                <Link
                  key={scope.id ?? "all"}
                  href={scope.id ? `/parametres?objectifs=${scope.id}#objectifs` : "/parametres#objectifs"}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-brand-600",
                    active ? "bg-brand-700 text-white" : "text-slate-700 hover:bg-slate-100",
                  )}
                >
                  {scope.name}
                </Link>
              );
            })}
          </nav>
          <TargetsForm
            key={depot?.id ?? "all"}
            action={saveKpiTargets.bind(null, depot?.id ?? null)}
            initial={targetsFormValues(targets, depot?.id ?? null)}
            companyValues={depot ? targetsFormValues(targets, null) : null}
            depotName={depot?.name ?? null}
          />
        </CardBody>
      </Card>
    </div>
  );
}
