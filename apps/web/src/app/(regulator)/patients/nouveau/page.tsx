import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { geocoderEnabled } from "@/lib/geocode";
import { EMPTY_ADDRESS } from "@/components/address/address-utils";
import { BackLink } from "@/components/ui/back-link";
import Link from "next/link";
import { PageHeader } from "@/components/ui/layout";
import { Notice } from "@/components/ui/notice";
import { createPatient } from "../actions";
import { PatientForm } from "../_components/patient-form";

export const metadata: Metadata = { title: "Nouveau patient" };

export default async function NewPatientPage() {
  await requireUser("REGULATOR");

  return (
    <div>
      <BackLink href="/patients">Patients</BackLink>
      <PageHeader
        title="Nouveau patient"
        description="Ajoutez ensuite sa prescription puis ses récurrences depuis la fiche patient."
      />
      <Notice size="sm" tone="info" className="mb-5 max-w-3xl">
        Patient d&apos;une série de soins (dialyse, radiothérapie…)&nbsp;?{" "}
        <Link href="/patients/nouveau-regulier" className="font-medium underline underline-offset-2">
          Nouveau patient régulier
        </Link>{" "}
        réunit la fiche, la prescription et le rythme des séances, et crée ses courses à l&apos;enregistrement.
      </Notice>
      <PatientForm
        action={createPatient}
        initial={{
          lastName: "",
          firstName: "",
          phone: "",
          mobility: "SEATED",
          accessNotes: "",
          address: EMPTY_ADDRESS,
        }}
        geocoderEnabled={geocoderEnabled()}
        submitLabel="Créer le patient"
        cancelHref="/patients"
      />
    </div>
  );
}
