import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { geocoderEnabled } from "@/lib/geocode";
import { addressFormValues } from "@/components/address/address-utils";
import { PageHeader } from "@/components/ui/layout";
import { formatMinute, todayIso } from "@/lib/time";
import { parseOpeningHours } from "@/lib/domain/facility-hours";
import { countOpenTrips } from "@/app/(regulator)/patients/_lib/trip-counts";
import { openTripsLabel } from "@/app/(regulator)/patients/_lib/trip-sync";
import { updateFacility } from "../../actions";
import { FacilityForm } from "../../_components/facility-form";
import { BackLink } from "@/components/ui/back-link";

export const metadata: Metadata = { title: "Modifier l'établissement" };

export default async function EditFacilityPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser("REGULATOR");
  const { id } = await params;
  const facility = await db.facility.findUnique({ where: { id } });
  if (!facility) notFound();
  const openTrips = await countOpenTrips({ facilityId: facility.id }, todayIso());

  return (
    <div>
      <BackLink href={`/etablissements/${facility.id}`}>{facility.name}</BackLink>
      <PageHeader
        title="Modifier l'établissement"
        description={
          openTrips === 1
            ? "Un changement d'adresse s'applique aussi à la course à venir non commencée vers cet établissement (retirée de sa tournée si elle y est déjà)."
            : openTrips > 1
              ? `Un changement d'adresse s'applique aussi aux ${openTripsLabel(openTrips)} non commencées vers cet établissement\u202f; celles déjà dans une tournée en sont retirées.`
              : "Un changement d'adresse s'applique aux courses générées ensuite."
        }
      />
      <FacilityForm
        action={updateFacility.bind(null, facility.id)}
        initial={{
          name: facility.name,
          type: facility.type,
          phone: facility.phone ?? "",
          notes: facility.notes ?? "",
          extraServiceMin: String(facility.extraServiceMin),
          openOnHolidays: facility.openOnHolidays,
          earliestArrival: facility.earliestArrivalMinute !== null ? formatMinute(facility.earliestArrivalMinute) : "",
          hours: Object.fromEntries(
            parseOpeningHours(facility.openingHours).map((h) => [
              String(h.weekday),
              { open: formatMinute(h.openMinute), close: formatMinute(h.closeMinute) },
            ]),
          ),
          address: addressFormValues(facility),
        }}
        geocoderEnabled={geocoderEnabled()}
        submitLabel="Enregistrer"
        cancelHref={`/etablissements/${facility.id}`}
      />
    </div>
  );
}
