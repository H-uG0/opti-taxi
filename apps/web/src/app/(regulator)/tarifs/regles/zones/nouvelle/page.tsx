import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/layout";
import { requireUser } from "@/lib/auth";
import { BackLink } from "../../../../vehicules/_lib/ui";
import { createArea } from "../../actions";
import { AreaForm } from "../../forms";
import { areaFormValues } from "../../schema";

export const metadata: Metadata = { title: "Nouvelle zone tarifaire" };

export default async function NewAreaPage() {
  await requireUser("REGULATOR");
  return (
    <div className="max-w-5xl">
      <BackLink href="/tarifs/regles">Règles de facturation</BackLink>
      <PageHeader
        title="Nouvelle zone tarifaire"
        description="Communes au forfait « Grande ville » (taxi) ou au forfait agglomération (ambulance)."
      />
      <AreaForm action={createArea} initial={areaFormValues()} submitLabel="Créer la zone" />
    </div>
  );
}
