import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/layout";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { VEHICLE_TYPE_SHORT } from "@/lib/labels";
import { todayIso } from "@/lib/time";
import { departmentLabel } from "../../vehicules/_lib/departments";
import { idSchema } from "@/lib/forms";
import { BackLink, Callout } from "../../vehicules/_lib/ui";
import { createTariff } from "../actions";
import { tariffFormValues } from "../schema";
import { TariffForm } from "../tariff-form";

export const metadata: Metadata = { title: "Nouvelle grille tarifaire" };

export default async function NewTariffPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("REGULATOR");
  const { depuis } = await searchParams;
  const sourceId = idSchema.safeParse(depuis);
  // "Dupliquer": start a new version from an existing grid, effective today, open-ended.
  const source = sourceId.success ? await db.tariffGrid.findUnique({ where: { id: sourceId.data } }) : null;

  return (
    <div className="max-w-5xl">
      <BackLink href="/tarifs">Grilles tarifaires</BackLink>
      <PageHeader
        title={source ? "Nouvelle version d'une grille" : "Nouvelle grille tarifaire"}
        description="Une grille s'applique aux véhicules d'un type rattachés à un département, entre deux dates."
      />
      {source ? (
        <Callout className="mb-6">
          <p>
            Valeurs reprises de la grille {VEHICLE_TYPE_SHORT[source.vehicleType]} · {departmentLabel(source.department)}
            {source.label ? ` « ${source.label} »` : ""}. Ajustez les montants et la date d&apos;effet : à partir de
            cette date, la nouvelle grille remplacera l&apos;ancienne, qui reste dans l&apos;historique.
          </p>
        </Callout>
      ) : null}
      <TariffForm
        action={createTariff}
        initial={source ? tariffFormValues(source, { validFrom: todayIso(), validTo: "" }) : tariffFormValues(undefined, { validFrom: todayIso() })}
        submitLabel="Créer la grille"
      />
    </div>
  );
}
