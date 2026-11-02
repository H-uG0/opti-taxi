import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { geocoderEnabled } from "@/lib/geocode";
import { EMPTY_ADDRESS } from "@/components/address/address-utils";
import { PageHeader } from "@/components/ui/layout";
import { createPatient } from "../actions";
import { PatientForm } from "../_components/patient-form";

export const metadata: Metadata = { title: "Nouveau patient" };

export default async function NewPatientPage() {
  await requireUser("REGULATOR");

  return (
    <div>
      <PageHeader
        title="Nouveau patient"
        description="Ajoutez ensuite sa prescription puis ses récurrences depuis la fiche patient."
      />
      <PatientForm
        action={createPatient}
        initial={{
          lastName: "",
          firstName: "",
          phone: "",
          mobility: "SEATED",
          accessNotes: "",
          active: true,
          address: EMPTY_ADDRESS,
        }}
        geocoderEnabled={geocoderEnabled()}
        submitLabel="Créer le patient"
        cancelHref="/patients"
      />
    </div>
  );
}
