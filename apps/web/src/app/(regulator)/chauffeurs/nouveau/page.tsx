import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/layout";
import { requireUser } from "@/lib/auth";
import { loadDepotOptions } from "@/app/(regulator)/depots/options";
import { createDriver } from "../actions";
import { DriverForm } from "../driver-form";
import { driverFormValues } from "../schema";
import { BackLink } from "@/components/ui/back-link";

export const metadata: Metadata = { title: "Nouvelle personne" };

export default async function NewDriverPage() {
  await requireUser("REGULATOR");
  const depots = await loadDepotOptions();

  return (
    <div className="max-w-5xl">
      <BackLink href="/chauffeurs">Personnel</BackLink>
      <PageHeader
        title="Nouvelle personne"
        description="Après l'enregistrement, vous pourrez lui créer un accès à sa feuille de route."
      />
      <DriverForm
        action={createDriver}
        initial={driverFormValues()}
        depots={depots}
        submitLabel="Créer la fiche" cancelHref="/chauffeurs" />
    </div>
  );
}
