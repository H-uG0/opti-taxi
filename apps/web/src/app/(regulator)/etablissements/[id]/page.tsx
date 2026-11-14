import type { Metadata } from "next";
import Link from "next/link";
import { FormMessage } from "@/components/ui/form";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Pencil } from "lucide-react";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { FACILITY_TYPE_LABELS, PRESCRIBED_MODE_LABELS, RECURRENCE_LEGS_LABELS } from "@/lib/labels";
import { formatMinute, fromIsoDate, todayIso, tomorrowIso, toIsoDate } from "@/lib/time";
import { formatCoordinate } from "@/components/address/address-utils";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/layout";
import { TBody, Td, Th, THead } from "@/components/ui/table";
import { ActionButton } from "@/components/ui/action-button";
import { SyncNotice } from "@/app/(regulator)/patients/_components/sync-notice";
import { describeRhythmDays } from "@/lib/domain/recurrence-rhythm";
import { setFacilityActive } from "../actions";
import { addFacilityClosure, deleteFacilityClosure } from "../closure-actions";
import { ClosureForm } from "../_components/closure-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { closureText } from "@/lib/domain/facility-calendar";
import { describeOpeningHours, parseOpeningHours } from "@/lib/domain/facility-hours";
import { recordAbsenceFrom } from "@/lib/domain/patient-absences";
import { BackLink } from "@/components/ui/back-link";
import { Notice } from "@/components/ui/notice";
import { DropNoticeParams } from "@/components/ui/notice-params";

/** The tab names the record (never a patient: titles stay in the browser history). */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  // Metadata resolves alongside the layout: it checks the role itself before reading the record (its name is the title).
  await requireUser("REGULATOR");
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
      // Closures to come, and those ended less than 30 days ago (to correct a mistake).
      closures: { where: { endDate: { gte: fromIsoDate(recordAbsenceFrom(todayIso())) } }, orderBy: { startDate: "asc" } },
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
  const hoursText = describeOpeningHours(parseOpeningHours(facility.openingHours));
  const activePatients = new Set(recurrences.filter((r) => r.patient.active).map((r) => r.patient.id));

  return (
    <div className="space-y-6">
      <div>
        <BackLink href="/etablissements">Établissements</BackLink>
        <PageHeader
          title={
            <span className="flex flex-wrap items-center gap-3">
              {facility.name}
              <Badge tone={facility.active ? "success" : "neutral"}>{facility.active ? "Actif" : "Désactivé"}</Badge>
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
                        question: `Désactiver «\u202f${facility.name}\u202f»\u202f? Il ne sera plus proposé dans les nouvelles récurrences. L'historique est conservé.`,
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
          {query.cree === "1" ? <FormMessage tone="success">Établissement créé.</FormMessage> : null}
          {query.enregistre === "1" ? <FormMessage tone="success">Modifications enregistrées.</FormMessage> : null}
          {query.cree === "1" || query.enregistre === "1" ? <DropNoticeParams /> : null}
          <SyncNotice query={query} />
          {!facility.active ? (
            <Notice size="sm" tone="info">
              Établissement désactivé&nbsp;: il n&apos;est plus proposé dans les nouvelles récurrences. Son historique est conservé.
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
            <Item label="Horaires d'accueil" className="sm:col-span-2">
              {hoursText ? (
                <span className="tabular">{hoursText}</span>
              ) : (
                <span className="text-slate-500">Non renseignés (aucune contrainte)</span>
              )}
              {facility.earliestArrivalMinute !== null ? (
                <span className="tabular mt-0.5 block text-xs text-slate-600">
                  Arrivée des patients acceptée dès {formatMinute(facility.earliestArrivalMinute)}
                </span>
              ) : null}
            </Item>
            <Item label="Temps d'arrêt en plus">
              {facility.extraServiceMin > 0 ? (
                <span className="tabular">{facility.extraServiceMin}&nbsp;min à chaque dépose et prise en charge ici</span>
              ) : (
                <span className="text-slate-500">Aucun</span>
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
            <Item label="Consignes de dépose" className="sm:col-span-2 lg:col-span-4">
              {facility.notes ? (
                <span className="whitespace-pre-line">{facility.notes}</span>
              ) : (
                <span className="text-slate-500">Aucune</span>
              )}
            </Item>
          </dl>
        </CardBody>
      </Card>

      <Card id="calendrier" className="scroll-mt-6">
        <CardHeader title="Jours fériés et fermetures" />
        <CardBody className="space-y-4 text-sm text-slate-700">
          <p>
            {facility.openOnHolidays ? (
              <>
                <Badge tone="success">Ouvert les jours fériés</Badge>{" "}
                <span className="text-slate-600">Ses courses ces jours-là sont planifiées comme les autres.</span>
              </>
            ) : (
              <>
                <Badge tone="neutral">Fermé les jours fériés</Badge>{" "}
                <span className="text-slate-600">
                  Ses courses ces jours-là sont signalées sur le planning et dans Courses, avec «&#x202F;Annuler ces
                  courses&#x202F;» (réglage dans «&#x202F;Modifier&#x202F;»).
                </span>
              </>
            )}
          </p>
          <p className="text-xs text-slate-500">
            Une fermeture datée (congés, travaux) annule les courses vers l&apos;établissement ces jours-là et empêche les
            récurrences d&apos;en créer&#x202F;; supprimée, les courses reviennent d&apos;elles-mêmes à partir de demain.
          </p>
          {facility.closures.length === 0 ? (
            <p className="text-slate-500">Aucune fermeture à venir.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {facility.closures.map((c) => {
                const period = { startDate: toIsoDate(c.startDate), endDate: toIsoDate(c.endDate) };
                const text = closureText(period);
                const past = period.endDate < todayIso();
                return (
                  <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                    <div>
                      <p className={past ? "text-slate-500" : "font-medium text-slate-900"}>
                        {text}
                        {past ? " (passée)" : ""}
                      </p>
                      {c.note ? <p className="text-xs text-slate-500">{c.note}</p> : null}
                    </div>
                    <ConfirmAction
                      action={deleteFacilityClosure.bind(null, facility.id, c.id)}
                      label="Supprimer"
                      ariaLabel={`Supprimer la fermeture ${text.toLowerCase()}`}
                      confirmLabel="Oui, supprimer la fermeture"
                      keepLabel="Garder la fermeture"
                      triggerVariant="ghost"
                      question={
                        <p>
                          Supprimer «&#x202F;{text}&#x202F;»&#x202F;? Les courses annulées pour cette fermeture reviennent à partir de
                          demain.
                        </p>
                      }
                    />
                  </li>
                );
              })}
            </ul>
          )}
          <details className="rounded-md border border-slate-200 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-brand-700">Nouvelle fermeture</summary>
            <div className="pt-3">
              <ClosureForm action={addFacilityClosure.bind(null, facility.id)} defaultDate={tomorrowIso()} />
            </div>
          </details>
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
                          Patient désactivé
                        </Badge>
                      ) : null}
                    </Td>
                    <Td className="tabular whitespace-nowrap">
                      {describeRhythmDays({ ...r, sessionDates: r.sessionDates.map(toIsoDate) })} · {formatMinute(r.appointmentMinute)}
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
