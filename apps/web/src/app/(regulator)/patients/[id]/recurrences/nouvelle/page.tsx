import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { todayIso } from "@/lib/time";
import { LinkButton } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { createRecurrence } from "../../../actions";
import { RecurrenceForm } from "../../../_components/recurrence-form";
import { loadRecurrenceOptions } from "../../../_lib/recurrence-options";
import { pickCurrentPrescription } from "../../../_lib/status";
import { BackLink } from "@/components/ui/back-link";

export const metadata: Metadata = { title: "Nouvelle récurrence" };

export default async function NewRecurrencePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser("REGULATOR");
  const { id } = await params;
  const patient = await db.patient.findUnique({
    where: { id },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      prescriptions: { select: { id: true, validFrom: true, validTo: true } },
    },
  });
  if (!patient) notFound();

  const today = todayIso();
  const [{ facilities, prescriptions }] = await Promise.all([
    loadRecurrenceOptions(patient.id, today),
    auditRead(user, { action: "patient.view", entity: "Patient", entityId: patient.id }),
  ]);
  const current = pickCurrentPrescription(patient.prescriptions, today);
  const back = `/patients/${patient.id}#recurrences`;

  return (
    <div>
      <BackLink href={back}>
        <span className="uppercase">{patient.lastName}</span> {patient.firstName}
      </BackLink>
      <PageHeader
        title="Nouvelle récurrence"
        description="Ex. dialyse lundi, mercredi, vendredi, RDV 07:30&nbsp;: les courses de la semaine seront générées à partir de ce rythme."
      />
      {prescriptions.length === 0 || facilities.length === 0 ? (
        <EmptyState
          title={prescriptions.length === 0 ? "Aucune prescription pour ce patient" : "Aucun établissement actif"}
          action={
            prescriptions.length === 0 ? (
              <LinkButton href={`/patients/${patient.id}/prescriptions/nouvelle`} variant="primary">
                Nouvelle prescription
              </LinkButton>
            ) : (
              <LinkButton href="/etablissements/nouveau" variant="primary">
                Créer un établissement
              </LinkButton>
            )
          }
        >
          {prescriptions.length === 0
            ? "Une récurrence s'appuie sur une prescription\u00a0: saisissez-la d'abord."
            : "Une récurrence mène à un établissement de soins\u00a0: créez-le d'abord."}
        </EmptyState>
      ) : (
        <RecurrenceForm
          action={createRecurrence.bind(null, patient.id)}
          initial={{
            facilityId: facilities.length === 1 ? (facilities[0]?.id ?? "") : "",
            prescriptionId: current?.id ?? "",
            label: "",
            weekdays: [],
            appointmentTime: "",
            sessionMinutes: "",
            legs: "BOTH",
            startDate: today,
            endDate: "",
          }}
          facilities={facilities}
          prescriptions={prescriptions}
          todayIso={today}
          submitLabel="Ajouter la récurrence"
          cancelHref={back}
        />
      )}
    </div>
  );
}
