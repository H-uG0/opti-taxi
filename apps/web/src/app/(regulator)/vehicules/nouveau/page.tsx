import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/layout";
import { requireUser } from "@/lib/auth";
import { createVehicle } from "../actions";
import { loadDepotOptions } from "@/app/(regulator)/depots/options";
import { loadDriverOptions } from "../_lib/driver-options";
import { vehicleFormValues } from "../schema";
import { VehicleForm } from "../vehicle-form";
import { BackLink } from "@/components/ui/back-link";

export const metadata: Metadata = { title: "Nouveau véhicule" };

export default async function NewVehiclePage() {
  await requireUser("REGULATOR");
  const [drivers, depots] = await Promise.all([loadDriverOptions(), loadDepotOptions()]);

  return (
    <div className="max-w-5xl">
      <BackLink href="/vehicules">Véhicules</BackLink>
      <PageHeader
        title="Nouveau véhicule"
        description="Le véhicule sera proposé à l'optimisation dès son enregistrement."
      />
      <VehicleForm action={createVehicle} initial={vehicleFormValues()} drivers={drivers} depots={depots} submitLabel="Créer le véhicule" />
    </div>
  );
}
