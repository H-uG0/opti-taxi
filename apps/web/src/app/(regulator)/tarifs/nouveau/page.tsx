import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/layout";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { VEHICLE_TYPE_SHORT } from "@/lib/labels";
import { todayIso } from "@/lib/time";
import { departmentLabel } from "../../vehicules/_lib/departments";
import { idSchema } from "@/lib/forms";
import { createTariff } from "../actions";
import { duplicateOverrides, tariffFormValues } from "../schema";
import { TariffForm } from "../tariff-form";
import { BackLink } from "@/components/ui/back-link";
import { Notice } from "@/components/ui/notice";

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
        <Notice className="mb-6">
          <p>
            Valeurs reprises de la grille {VEHICLE_TYPE_SHORT[source.vehicleType]} · {departmentLabel(source.department)}
            {source.label ? ` «\u202f${source.label}\u202f»` : ""}. Ajustez les montants et la date d&apos;effet&nbsp;: à partir de
            cette date, la nouvelle grille remplacera l&apos;ancienne, qui reste dans l&apos;historique.
          </p>
          <p>
            La vérification repart à «&#x202F;Non vérifié&#x202F;» et la source est vide&nbsp;: indiquez le nouveau texte, puis «&#x202F;Officiel&#x202F;» une
            fois les montants vérifiés.
          </p>
        </Notice>
      ) : null}
      <TariffForm
        action={createTariff}
        initial={
          source
            ? tariffFormValues(source, duplicateOverrides(source, todayIso()))
            : tariffFormValues(undefined, { validFrom: todayIso() })
        }
        submitLabel="Créer la grille"
      />
    </div>
  );
}
