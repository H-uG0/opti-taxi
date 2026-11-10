import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Pencil } from "lucide-react";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { FACILITY_TYPE_LABELS, PRESCRIBED_MODE_LABELS, RECURRENCE_LEGS_LABELS } from "@/lib/labels";
import { formatMinute } from "@/lib/time";
import { formatCoordinate } from "@/components/address/address-utils";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/layout";
import { TBody, Td, Th, THead } from "@/components/ui/table";
import { ActionButton } from "@/components/ui/action-button";
import { SyncNotice } from "@/app/(regulator)/patients/_components/sync-notice";
import { formatWeekdays } from "@/app/(regulator)/patients/_lib/status";
import { setFacilityActive } from "../actions";
import { BackLink } from "@/components/ui/back-link";
import { Notice } from "@/components/ui/notice";

/** The tab names the record (never a patient: titles stay in the browser history). */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const record = await db.facility.findUnique({ where: { id }, select: { name: true } });
  return { title: record?.name ?? "Établissement" };
}

export default async function FacilityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("REGULATOR");
  const { id } = await params;
  const query = await searchParams;
  const facility = await db.facility.findUnique({
    where: { id },
    include: {
      recurrences: {
        where: { active: true },
        orderBy: [{ appointmentMinute: "asc" }],
        include: {
          patient: { select: { id: true, firstName: true, lastName: true, city: true, active: true } },
          prescription: { select: { mode: true } },
        },
      },
    },
  });
  if (!facility) notFound();
  // The page lists the patients treated here, with their days and times.
  await auditRead(user, { action: "facility.view", entity: "Facility", entityId: facility.id });

  const recurrences = [...facility.recurrences].sort(
    (a, b) =>
      a.patient.lastName.localeCompare(b.patient.lastName, "fr") ||
      a.patient.firstName.localeCompare(b.patient.firstName, "fr") ||
      a.appointmentMinute - b.appointmentMinute,
  );
  const activePatients = new Set(recurrences.filter((r) => r.patient.active).map((r) => r.patient.id));

  return (
    <div className="space-y-6">
      <div>
        <BackLink href="/etablissements">Établissements</BackLink>
        <PageHeader
          title={
            <span className="flex flex-wrap items-center gap-3">
              {facility.name}
              <Badge tone={facility.active ? "success" : "neutral"}>{facility.active ? "Actif" : "Inactif"}</Badge>
            </span>
          }
          description={`${FACILITY_TYPE_LABELS[facility.type]} · ${facility.city}`}
          actions={
            <>
              <LinkButton href={`/etablissements/${facility.id}/modifier`} size="sm">
                <Pencil aria-hidden className="size-4" />
                Modifier
              </LinkButton>
              <ActionButton
                action={setFacilityActive}
                fields={{ facilityId: facility.id, active: facility.active ? "false" : "true" }}
                confirm={
                  facility.active
                    ? {
                        question: `Désactiver « ${facility.name} » ? Il ne sera plus proposé dans les nouvelles récurrences. L'historique est conservé.`,
                        confirmLabel: "Oui, désactiver l'établissement",
                        keepLabel: "Garder l'établissement actif",
                      }
                    : undefined
                }
                variant={facility.active ? "secondary" : "primary"}
              >
                {facility.active ? "Désactiver" : "Réactiver"}
              </ActionButton>
            </>
          }
        />
        <div className="space-y-2">
          <SyncNotice query={query} />
          {!facility.active ? (
            <Notice size="sm" tone="info">
              Établissement désactivé : il n&apos;est plus proposé dans les nouvelles récurrences. Son historique est conservé.
            </Notice>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader title="Coordonnées" />
        <CardBody>
          <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Item label="Type">{FACILITY_TYPE_LABELS[facility.type]}</Item>
            <Item label="Téléphone de l'accueil">
              {facility.phone ? (
                <a href={`tel:${facility.phone.replace(/[^+\d]/g, "")}`} className="tabular text-brand-800 hover:underline">
                  {facility.phone}
                </a>
              ) : (
                <span className="text-amber-700">Non renseigné — nécessaire pour prévenir des arrivées partagées</span>
              )}
            </Item>
            <Item label="Temps d'arrêt en plus">
              {facility.extraServiceMin > 0 ? (
                <span className="tabular">{facility.extraServiceMin} min à chaque dépose et prise en charge ici</span>
              ) : (
                <span className="text-slate-400">Aucun</span>
              )}
            </Item>
            <Item label="Adresse" className="sm:col-span-2">
              {facility.address}
              <br />
              <span className="tabular">{facility.postalCode}</span> {facility.city}
              <span className="tabular mt-0.5 block text-xs text-slate-500">
                {formatCoordinate(facility.lat)}, {formatCoordinate(facility.lng)}
              </span>
            </Item>
            <Item label="Notes" className="sm:col-span-2 lg:col-span-4">
              {facility.notes ? (
                <span className="whitespace-pre-line">{facility.notes}</span>
              ) : (
                <span className="text-slate-400">Aucune</span>
              )}
            </Item>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={`Patients réguliers (${activePatients.size})`}
          actions={<span className="text-xs text-slate-500">Récurrences actives vers cet établissement</span>}
        />
        {recurrences.length === 0 ? (
          <CardBody>
            <p className="text-sm text-slate-600">
              Aucune récurrence active. Les récurrences se créent depuis la fiche de chaque patient.
            </p>
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <THead>
                <tr>
                  <Th>Patient</Th>
                  <Th>Jours et RDV</Th>
                  <Th>Trajets</Th>
                  <Th>Mode prescrit</Th>
                </tr>
              </THead>
              <TBody>
                {recurrences.map((r) => (
                  <tr key={r.id} className={r.patient.active ? undefined : "text-slate-500"}>
                    <Td className="whitespace-nowrap">
                      <Link
                        href={`/patients/${r.patient.id}#recurrences`}
                        className="font-medium underline-offset-2 hover:text-brand-800 hover:underline"
                      >
                        <span className="uppercase">{r.patient.lastName}</span> {r.patient.firstName}
                      </Link>
                      <span className="ml-1.5 text-xs text-slate-500">{r.patient.city}</span>
                      {!r.patient.active ? (
                        <Badge tone="neutral" className="ml-2">
                          Patient inactif
                        </Badge>
                      ) : null}
                    </Td>
                    <Td className="tabular whitespace-nowrap">
                      {formatWeekdays(r.weekdays)} · {formatMinute(r.appointmentMinute)}
                      {r.label ? <span className="ml-1.5 text-xs text-slate-500">{r.label}</span> : null}
                    </Td>
                    <Td className="whitespace-nowrap">{RECURRENCE_LEGS_LABELS[r.legs]}</Td>
                    <Td className="whitespace-nowrap">{PRESCRIBED_MODE_LABELS[r.prescription.mode]}</Td>
                  </tr>
                ))}
              </TBody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Item({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</dt>
      <dd className="mt-1 text-slate-900">{children}</dd>
    </div>
  );
}
