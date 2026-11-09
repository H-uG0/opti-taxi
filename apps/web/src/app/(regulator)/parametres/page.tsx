import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/layout";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/domain/settings";
import { loadTrafficZones } from "@/lib/domain/traffic";
import { loadObservedCalibration } from "@/lib/domain/traffic-observed";
import { TIME_ZONE } from "@/lib/time";
import { applyObservedTraffic, saveSettings, saveTraffic } from "./actions";
import { settingsFormValues } from "./schema";
import { SettingsForm } from "./settings-form";
import { TrafficForm } from "./traffic-form";
import { trafficFormValues } from "./traffic-schema";

export const metadata: Metadata = { title: "Paramètres" };

const updatedAtFormat = new Intl.DateTimeFormat("fr-FR", { timeZone: TIME_ZONE, dateStyle: "long", timeStyle: "short" });

export default async function SettingsPage() {
  await requireUser("REGULATOR");
  const [settings, zones] = await Promise.all([getSettings(db), loadTrafficZones(db)]);
  const calibration = await loadObservedCalibration(db, settings, zones);

  return (
    <div className="max-w-5xl space-y-8">
      <PageHeader
        title="Paramètres"
        description={`Règles appliquées à chaque calcul des tournées et numéro de la régulation affiché aux chauffeurs. Dernière modification : ${updatedAtFormat.format(settings.updatedAt)}.`}
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
    </div>
  );
}
