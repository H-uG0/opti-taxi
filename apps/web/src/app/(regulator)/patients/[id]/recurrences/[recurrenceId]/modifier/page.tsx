import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatMinute, todayIso, toIsoDate } from "@/lib/time";
import { PageHeader } from "@/components/ui/layout";
import { updateRecurrence } from "../../../../actions";
import { BackLink } from "../../../../_components/back-link";
import { RecurrenceForm } from "../../../../_components/recurrence-form";
import { Warning } from "../../../../_components/warning";
import { loadRecurrenceOptions } from "../../../../_lib/recurrence-options";
import { countOpenTrips } from "../../../../_lib/trip-counts";
import { openTripsLabel } from "../../../../_lib/trip-sync";

export const metadata: Metadata = { title: "Modifier la récurrence" };

export default async function EditRecurrencePage({
  params,
}: {
  params: Promise<{ id: string; recurrenceId: string }>;
}) {
  await requireUser("REGULATOR");
  const { id, recurrenceId } = await params;
  const recurrence = await db.recurrence.findFirst({
    where: { id: recurrenceId, patientId: id },
    include: { patient: { select: { id: true, firstName: true, lastName: true } } },
  });
  if (!recurrence) notFound();
  const { patient } = recurrence;

  const today = todayIso();
  const [{ facilities, prescriptions }, openTrips] = await Promise.all([
    loadRecurrenceOptions(patient.id, today, recurrence.facilityId),
    countOpenTrips({ recurrenceId: recurrence.id }, today),
  ]);
  const back = `/patients/${patient.id}#recurrences`;

  return (
    <div>
      <BackLink href={back}>
        <span className="uppercase">{patient.lastName}</span> {patient.firstName}
      </BackLink>
      <PageHeader title="Modifier la récurrence" />
      <Warning tone="info" className="mb-5 max-w-3xl">
        {openTrips > 0 ? (
          <>
            {openTripsLabel(openTrips)} de cette récurrence {openTrips === 1 ? "suivra" : "suivront"} la modification
            (horaire, établissement, prescription). Une course qui ne tombe plus un jour, un trajet ou une période prévus
            sera annulée ; une course dont l&apos;horaire a été changé à la main garde son horaire.
          </>
        ) : (
          "Les modifications s'appliquent aux courses générées ensuite."
        )}
        {recurrence.active ? null : " Cette récurrence est désactivée : réactivez-la depuis la fiche patient."}
      </Warning>
      <RecurrenceForm
        action={updateRecurrence.bind(null, patient.id, recurrence.id)}
        initial={{
          facilityId: recurrence.facilityId,
          prescriptionId: recurrence.prescriptionId,
          label: recurrence.label ?? "",
          weekdays: recurrence.weekdays.map(String),
          appointmentTime: formatMinute(recurrence.appointmentMinute),
          sessionMinutes: String(recurrence.sessionMinutes),
          legs: recurrence.legs,
          startDate: toIsoDate(recurrence.startDate),
          endDate: recurrence.endDate ? toIsoDate(recurrence.endDate) : "",
        }}
        facilities={facilities}
        prescriptions={prescriptions}
        todayIso={today}
        submitLabel="Enregistrer"
        cancelHref={back}
      />
    </div>
  );
}
