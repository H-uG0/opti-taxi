import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/layout";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { AREA_KIND_LABELS } from "@/lib/domain/tariff-areas";
import { deleteArea, updateArea } from "../../actions";
import { AreaForm } from "../../forms";
import { areaFormValues } from "../../schema";
import { BackLink } from "@/components/ui/back-link";

export const metadata: Metadata = { title: "Zone tarifaire" };

export default async function EditAreaPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser("REGULATOR");
  const { id } = await params;
  const area = await db.tariffArea.findUnique({ where: { id } });
  if (!area) notFound();
  return (
    <div className="max-w-5xl">
      <BackLink href="/tarifs/regles">Règles de facturation</BackLink>
      <PageHeader title={area.name} description={AREA_KIND_LABELS[area.kind]} />
      <div className="space-y-6">
        <AreaForm action={updateArea.bind(null, area.id)} initial={areaFormValues(area)} submitLabel="Enregistrer" />
        <Card>
          <CardHeader title="Supprimer la zone" />
          <CardBody className="space-y-3 text-sm text-slate-700">
            <p>Les calculs suivants n&apos;appliqueront plus son forfait. Pour une liste qui change, préférez des dates de validité.</p>
            <ConfirmAction
              action={deleteArea.bind(null, area.id)}
              label="Supprimer la zone"
              confirmLabel="Oui, supprimer la zone"
              keepLabel="Garder la zone"
              question={<p>La zone sera supprimée définitivement. Cette action est irréversible.</p>}
            />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
