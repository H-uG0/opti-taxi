import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody, EmptyState, PageHeader } from "@/components/ui/layout";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { geocoderEnabled } from "@/lib/geocode";
import { FACILITY_TYPE_LABELS, MOBILITY_LABELS, PRESCRIBED_MODE_LABELS, SHARING_SCOPE_LABELS } from "@/lib/labels";
import { formatShortDate, fromIsoDate, isIsoDate, todayIso, toIsoDate, tomorrowIso } from "@/lib/time";
import { NewTripForm, type FacilityOption, type PatientOption } from "./new-trip-form";

export const metadata: Metadata = { title: "Nouvelle course" };

export default async function NewTripPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("REGULATOR");
  const params = await searchParams;
  const rawDate = Array.isArray(params.date) ? params.date[0] : params.date;
  const today = todayIso();
  const initialDate = isIsoDate(rawDate) && rawDate >= today ? rawDate : tomorrowIso();

  const [patients, facilities] = await Promise.all([
    db.patient.findMany({
      where: { active: true },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        city: true,
        mobility: true,
        prescriptions: {
          where: { validTo: { gte: fromIsoDate(today) } },
          orderBy: { validFrom: "asc" },
          select: { id: true, mode: true, sharing: true, validFrom: true, validTo: true, prescriber: true },
        },
      },
    }),
    db.facility.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, city: true, type: true },
    }),
  ]);

  const patientOptions: PatientOption[] = patients.map((patient) => ({
    id: patient.id,
    label: `${patient.lastName.toUpperCase()} ${patient.firstName} — ${patient.city}`,
    mobilityLabel: MOBILITY_LABELS[patient.mobility],
    prescriptions: patient.prescriptions.map((p) => {
      const validFrom = toIsoDate(p.validFrom);
      const validTo = toIsoDate(p.validTo);
      return {
        id: p.id,
        mode: p.mode,
        sharing: p.sharing,
        validFrom,
        validTo,
        label: [
          PRESCRIBED_MODE_LABELS[p.mode],
          `partage ${SHARING_SCOPE_LABELS[p.sharing].toLowerCase()}`,
          `du ${formatShortDate(validFrom)} au ${formatShortDate(validTo)}`,
          p.prescriber,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    }),
  }));

  const facilityOptions: FacilityOption[] = facilities.map((facility) => ({
    id: facility.id,
    label: `${facility.name} — ${facility.city} (${FACILITY_TYPE_LABELS[facility.type]})`,
  }));

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Nouvelle course"
        description="Course ponctuelle, hors récurrence : elle sera placée dans une tournée à la prochaine optimisation."
        actions={
          <LinkButton href={`/courses?date=${initialDate}`} variant="ghost">
            <ArrowLeft aria-hidden className="size-4" />
            Retour aux courses
          </LinkButton>
        }
      />
      {patientOptions.length === 0 ? (
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
              patients={patientOptions}
              facilities={facilityOptions}
              initialDate={initialDate}
              today={today}
              geocoder={geocoderEnabled()}
            />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
