import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { todayIso, toIsoDate } from "@/lib/time";
import { PageHeader } from "@/components/ui/layout";
import { updatePrescription } from "../../../../actions";
import { PrescriptionForm } from "../../../../_components/prescription-form";
import { countOpenTrips } from "../../../../_lib/trip-counts";
import { openTripsLabel } from "../../../../_lib/trip-sync";
import { BackLink } from "@/components/ui/back-link";
import { Notice } from "@/components/ui/notice";

export const metadata: Metadata = { title: "Modifier la prescription" };

export default async function EditPrescriptionPage({
  params,
}: {
  params: Promise<{ id: string; prescriptionId: string }>;
}) {
  const user = await requireUser("REGULATOR");
  const { id, prescriptionId } = await params;
  const prescription = await db.prescription.findFirst({
    where: { id: prescriptionId, patientId: id },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true, mobility: true } },
      _count: { select: { recurrences: true } },
    },
  });
  if (!prescription) notFound();
  const { patient } = prescription;
  // Prescribed mode, prescriber and notes of an identified patient are shown in the form.
  // Traced on the patient: a prescription can be deleted, the patient stays.
  await auditRead(user, { action: "prescription.view", entity: "Patient", entityId: patient.id });
  const today = todayIso();
  const openTrips = await countOpenTrips({ prescriptionId: prescription.id }, today);
  const recurrences = prescription._count.recurrences;

  return (
    <div>
      <BackLink href={`/patients/${patient.id}#prescriptions`}>
        <span className="uppercase">{patient.lastName}</span> {patient.firstName}
      </BackLink>
      <PageHeader title="Modifier la prescription" />
      {recurrences > 0 || openTrips > 0 ? (
        <Notice size="sm" tone="info" className="mb-5 max-w-3xl">
          {recurrences > 0
            ? `${recurrences === 1 ? "1 récurrence s'appuie" : `${recurrences} récurrences s'appuient`} sur cette prescription : les prochaines courses générées suivront le nouveau mode et les nouvelles dates. `
            : null}
          {openTrips > 0
            ? `${openTripsLabel(openTrips)} déjà ${openTrips === 1 ? "générée suit" : "générées suivent"} aussi la modification à l'enregistrement : véhicule autorisé et partage selon le nouveau mode ; ${openTrips === 1 ? "annulée si elle sort" : "annulées si elles sortent"} de la nouvelle validité ; ${openTrips === 1 ? "retirée de sa tournée si elle n'y est plus compatible" : "retirées de leur tournée si elles n'y sont plus compatibles"}.`
            : null}
        </Notice>
      ) : null}
      <PrescriptionForm
        action={updatePrescription.bind(null, patient.id, prescription.id)}
        initial={{
          mode: prescription.mode,
          sharing: prescription.sharing,
          validFrom: toIsoDate(prescription.validFrom),
          validTo: toIsoDate(prescription.validTo),
          isSeries: prescription.isSeries,
          prescriber: prescription.prescriber ?? "",
          notes: prescription.notes ?? "",
        }}
        mobility={patient.mobility}
        todayIso={today}
        submitLabel="Enregistrer"
        cancelHref={`/patients/${patient.id}#prescriptions`}
      />
    </div>
  );
}
