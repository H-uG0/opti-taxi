import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { todayIso } from "@/lib/time";
import { PageHeader } from "@/components/ui/layout";
import { createPrescription } from "../../../actions";
import { BackLink } from "../../../_components/back-link";
import { PrescriptionForm } from "../../../_components/prescription-form";

export const metadata: Metadata = { title: "Nouvelle prescription" };

export default async function NewPrescriptionPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser("REGULATOR");
  const { id } = await params;
  const patient = await db.patient.findUnique({
    where: { id },
    select: { id: true, firstName: true, lastName: true, mobility: true },
  });
  if (!patient) notFound();
  await auditRead(user, { action: "patient.view", entity: "Patient", entityId: patient.id });

  const today = todayIso();
  const lying = patient.mobility === "LYING";

  return (
    <div>
      <BackLink href={`/patients/${patient.id}#prescriptions`}>
        <span className="uppercase">{patient.lastName}</span> {patient.firstName}
      </BackLink>
      <PageHeader
        title="Nouvelle prescription"
        description="Prescription médicale de transport (PMT) : mode, partage autorisé et période de validité."
      />
      <PrescriptionForm
        action={createPrescription.bind(null, patient.id)}
        initial={{
          mode: lying ? "AMBULANCE" : "TAP",
          sharing: lying ? "NONE" : "BOTH",
          validFrom: today,
          validTo: "",
          isSeries: false,
          prescriber: "",
          notes: "",
        }}
        mobility={patient.mobility}
        todayIso={today}
        submitLabel="Ajouter la prescription"
        cancelHref={`/patients/${patient.id}#prescriptions`}
      />
    </div>
  );
}
