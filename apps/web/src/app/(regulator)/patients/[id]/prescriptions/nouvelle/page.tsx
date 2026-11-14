import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { isIsoDate, todayIso } from "@/lib/time";
import { PageHeader } from "@/components/ui/layout";
import { createPrescription } from "../../../actions";
import { PrescriptionForm } from "../../../_components/prescription-form";
import { BackLink } from "@/components/ui/back-link";
import { newTripHref, readTripDraft } from "../../../../courses/nouvelle/trip-draft";

export const metadata: Metadata = { title: "Nouvelle prescription" };

export default async function NewPrescriptionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("REGULATOR");
  const { id } = await params;
  // Opened from « Nouvelle course » (?course=<date> and its choices): back to the new trip, as it was, once saved.
  const query = await searchParams;
  const course = Array.isArray(query.course) ? query.course[0] : query.course;
  const draft = readTripDraft(query);
  const patient = await db.patient.findUnique({
    where: { id },
    select: { id: true, firstName: true, lastName: true, mobility: true },
  });
  if (!patient) notFound();
  await auditRead(user, { action: "patient.view", entity: "Patient", entityId: patient.id });

  const today = todayIso();
  const lying = patient.mobility === "LYING";
  const returnDate = isIsoDate(course) && course >= today ? course : null;
  const back = returnDate ? newTripHref(patient.id, returnDate, draft) : `/patients/${patient.id}#prescriptions`;

  return (
    <div>
      <BackLink href={back}>
        {returnDate ? (
          "Nouvelle course"
        ) : (
          <>
            <span className="uppercase">{patient.lastName}</span> {patient.firstName}
          </>
        )}
      </BackLink>
      <PageHeader
        title="Nouvelle prescription"
        description="Prescription médicale de transport (PMT)&nbsp;: mode, partage autorisé et période de validité."
      />
      <PrescriptionForm
        action={createPrescription.bind(null, patient.id, returnDate ? { date: returnDate, draft } : null)}
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
        cancelHref={back}
      />
    </div>
  );
}
