import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/layout";
import { requireUser } from "@/lib/auth";
import { loadDepotOptions } from "@/app/(regulator)/depots/options";
import { BackLink } from "../../vehicules/_lib/ui";
import { createDriver } from "../actions";
import { DriverForm } from "../driver-form";
import { driverFormValues } from "../schema";

export const metadata: Metadata = { title: "Nouveau chauffeur" };

export default async function NewDriverPage() {
  await requireUser("REGULATOR");
  const depots = await loadDepotOptions();

  return (
    <div className="max-w-5xl">
      <BackLink href="/chauffeurs">Chauffeurs</BackLink>
      <PageHeader
        title="Nouveau chauffeur"
        description="Après l'enregistrement, vous pourrez lui créer un accès à sa feuille de route."
      />
      <DriverForm
        action={createDriver}
        initial={driverFormValues()}
        depots={depots}
        submitLabel="Créer le chauffeur" cancelHref="/chauffeurs" />
    </div>
  );
}
