import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { geocoderEnabled } from "@/lib/geocode";
import { EMPTY_ADDRESS } from "@/components/address/address-utils";
import { PageHeader } from "@/components/ui/layout";
import { BackLink } from "@/app/(regulator)/patients/_components/back-link";
import { createFacility } from "../actions";
import { FacilityForm } from "../_components/facility-form";

export const metadata: Metadata = { title: "Nouvel établissement" };

export default async function NewFacilityPage() {
  await requireUser("REGULATOR");

  return (
    <div>
      <BackLink href="/etablissements">Établissements</BackLink>
      <PageHeader title="Nouvel établissement" description="Lieu de soins, destination des courses régulières." />
      <FacilityForm
        action={createFacility}
        initial={{ name: "", type: "DIALYSIS", phone: "", notes: "", extraServiceMin: "0", address: EMPTY_ADDRESS }}
        geocoderEnabled={geocoderEnabled()}
        submitLabel="Créer l'établissement"
        cancelHref="/etablissements"
      />
    </div>
  );
}
