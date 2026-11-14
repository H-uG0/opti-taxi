import type { Metadata } from "next";
import { BackLink } from "@/components/ui/back-link";
import { PageHeader } from "@/components/ui/layout";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { geocoderEnabled } from "@/lib/geocode";
import { FACILITY_TYPE_LABELS } from "@/lib/labels";
import { todayIso } from "@/lib/time";
import { currentHorizon } from "@/lib/trips/completion";
import { createRegularPatient } from "../actions";
import { RegularPatientForm } from "../_components/regular-patient-form";

export const metadata: Metadata = { title: "Nouveau patient régulier" };

/**
 * « Nouveau patient régulier »: a patient met by phone with their prescription
 * and their rhythm of care, on one screen (« Nouveau patient » and the record's
 * forms stay for the other cases and to change them).
 */
export default async function NewRegularPatientPage() {
  await requireUser("REGULATOR");
  const today = todayIso();
  const [facilities, horizon] = await Promise.all([
    db.facility.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, city: true, type: true } }),
    currentHorizon(db, today),
  ]);

  return (
    <div>
      <BackLink href="/patients">Patients</BackLink>
      <PageHeader
        title="Nouveau patient régulier"
        description="Fiche, prescription et rythme des séances en un seul écran&nbsp;: les courses des prochains jours sont créées à l'enregistrement."
      />
      <RegularPatientForm
        action={createRegularPatient}
        facilities={facilities.map((f) => ({ ...f, typeLabel: FACILITY_TYPE_LABELS[f.type] }))}
        todayIso={today}
        geocoderEnabled={geocoderEnabled()}
        horizonEnd={horizon.to}
      />
    </div>
  );
}
