import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/layout";
import { requireUser } from "@/lib/auth";
import { BackLink } from "@/app/(regulator)/vehicules/_lib/ui";
import { createDepot } from "../actions";
import { DepotForm } from "../depot-form";
import { depotFormValues } from "../schema";

export const metadata: Metadata = { title: "Nouveau dépôt" };

export default async function NewDepotPage() {
  await requireUser("REGULATOR");

  return (
    <div className="max-w-5xl">
      <BackLink href="/depots">Dépôts</BackLink>
      <PageHeader
        title="Nouveau dépôt"
        description="Il sera proposé dans les fiches véhicule et chauffeur dès son enregistrement."
      />
      <DepotForm action={createDepot} initial={depotFormValues()} submitLabel="Créer le dépôt" />
    </div>
  );
}
