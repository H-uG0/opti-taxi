import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/layout";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/domain/settings";
import { TIME_ZONE } from "@/lib/time";
import { saveSettings } from "./actions";
import { settingsFormValues } from "./schema";
import { SettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Paramètres" };

const updatedAtFormat = new Intl.DateTimeFormat("fr-FR", { timeZone: TIME_ZONE, dateStyle: "long", timeStyle: "short" });

export default async function SettingsPage() {
  await requireUser("REGULATOR");
  const settings = await getSettings(db);

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Paramètres de l'optimiseur"
        description={`Règles appliquées à chaque calcul des tournées. Dernière modification : ${updatedAtFormat.format(settings.updatedAt)}.`}
      />
      <SettingsForm action={saveSettings} initial={settingsFormValues(settings)} />
    </div>
  );
}
