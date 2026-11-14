import type { Metadata } from "next";
import { LinkButton } from "@/components/ui/button";
import { BackLink } from "@/components/ui/back-link";
import { FormMessage } from "@/components/ui/form";
import { Card, CardBody, EmptyState, PageHeader } from "@/components/ui/layout";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { geocoderEnabled } from "@/lib/geocode";
import { FACILITY_TYPE_LABELS } from "@/lib/labels";
import { isIsoDate, todayIso, tomorrowIso } from "@/lib/time";
import { NewTripForm, type FacilityOption } from "./new-trip-form";
import { readTripDraft } from "./trip-draft";
import { loadTripPatient } from "./trip-patient";

export const metadata: Metadata = { title: "Nouvelle course" };

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * « Nouvelle course » : the patient is searched on the server as the regulator
 * types (never the whole list in the page); ?patient= (the button of the
 * patient's record) opens the form on that patient, their usual facility
 * proposed (« Annuler » leads back to the record unless ?retour=courses); ?date=
 * the day; the choices carried back from « Nouvelle prescription » (trip-draft.ts).
 */
export default async function NewTripPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("REGULATOR");
  const params = await searchParams;
  const rawDate = firstParam(params.date);
  const today = todayIso();
  const initialDate = isIsoDate(rawDate) && rawDate >= today ? rawDate : tomorrowIso();
  const patientId = firstParam(params.patient);

  const [anyPatient, facilities, initialPatient] = await Promise.all([
    db.patient.findFirst({ where: { active: true }, select: { id: true } }),
    db.facility.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, city: true, type: true },
    }),
    // The patient of the record the form was opened from (traced patient.view).
    patientId && patientId.length <= 64 ? loadTripPatient(user, patientId, today) : null,
  ]);

  const facilityOptions: FacilityOption[] = facilities.map((facility) => ({
    id: facility.id,
    label: `${facility.name} — ${facility.city} (${FACILITY_TYPE_LABELS[facility.type]})`,
  }));
  const read = readTripDraft(params);
  // A facility carried back that is no longer offered is dropped (the usual one is proposed instead).
  const draft = { ...read, facilityId: facilities.some((f) => f.id === read.facilityId) ? read.facilityId : undefined };
  const fromRecord = initialPatient !== null && !draft.fromCourses;
  const back = initialPatient && fromRecord ? `/patients/${initialPatient.id}` : `/courses?date=${initialDate}`;

  return (
    <div className="max-w-3xl">
      <BackLink href={back}>{fromRecord ? "Fiche patient" : "Courses"}</BackLink>
      <PageHeader
        title="Nouvelle course"
        description="Course ponctuelle, hors récurrence&nbsp;: un trajet, ou l'aller et le retour d'une consultation."
      />
      {initialPatient && firstParam(params.pmt) === "1" ? (
        <div className="mb-4">
          <FormMessage tone="success">Prescription enregistrée&nbsp;: elle est proposée ci-dessous si elle couvre la date.</FormMessage>
        </div>
      ) : null}
      {!anyPatient ? (
        <EmptyState
          title="Aucun patient actif"
          action={
            <LinkButton href="/patients" variant="secondary">
              Gérer les patients
            </LinkButton>
          }
        >
          Créez d&apos;abord la fiche du patient (adresse géocodée et prescription).
        </EmptyState>
      ) : (
        <Card>
          <CardBody>
            <NewTripForm
              initialPatient={initialPatient}
              facilities={facilityOptions}
              initialDate={initialDate}
              today={today}
              geocoder={geocoderEnabled()}
              draft={draft}
              fromRecord={fromRecord}
              cancelHref={fromRecord ? back : undefined}
            />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
