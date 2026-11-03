import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { geocoderEnabled } from "@/lib/geocode";
import { todayIso } from "@/lib/time";
import { addressFormValues } from "@/components/address/address-utils";
import { PageHeader } from "@/components/ui/layout";
import { updatePatient } from "../../actions";
import { PatientForm } from "../../_components/patient-form";
import { BackLink } from "../../_components/back-link";
import { countOpenTrips } from "../../_lib/trip-counts";
import { openTripsLabel } from "../../_lib/trip-sync";

export const metadata: Metadata = { title: "Modifier le patient" };

export default async function EditPatientPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser("REGULATOR");
  const { id } = await params;
  const patient = await db.patient.findUnique({ where: { id } });
  if (!patient) notFound();
  // The whole record is shown in the form: the read is traced like the patient page.
  const [openTrips] = await Promise.all([
    countOpenTrips({ patientId: patient.id }, todayIso()),
    auditRead(user, { action: "patient.view", entity: "Patient", entityId: patient.id }),
  ]);

  return (
    <div>
      <BackLink href={`/patients/${patient.id}`}>
        <span className="uppercase">{patient.lastName}</span> {patient.firstName}
      </BackLink>
      <PageHeader
        title="Modifier le patient"
        description={
          openTrips === 1
            ? "Un changement d'adresse s'applique aussi à sa course à venir non commencée (retirée de sa tournée si elle y est déjà)."
            : openTrips > 1
              ? `Un changement d'adresse s'applique aussi à ses ${openTripsLabel(openTrips)} non commencées (prise en charge à l'aller, dépose au retour) ; celles déjà dans une tournée en sont retirées.`
              : "Un changement d'adresse s'applique aux courses générées ensuite."
        }
      />
      <PatientForm
        action={updatePatient.bind(null, patient.id)}
        initial={{
          lastName: patient.lastName,
          firstName: patient.firstName,
          phone: patient.phone ?? "",
          mobility: patient.mobility,
          accessNotes: patient.accessNotes ?? "",
          active: patient.active,
          address: addressFormValues(patient),
        }}
        geocoderEnabled={geocoderEnabled()}
        submitLabel="Enregistrer"
        cancelHref={`/patients/${patient.id}`}
        activeHint={
          openTrips > 0
            ? `Décocher annule ${openTrips === 1 ? "sa course à venir non commencée" : `ses ${openTripsLabel(openTrips)} non commencées`}.`
            : undefined
        }
      />
    </div>
  );
}
