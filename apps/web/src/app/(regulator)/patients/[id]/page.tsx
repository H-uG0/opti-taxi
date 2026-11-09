import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import type { TripStatus } from "@prisma/client";
import { Pencil, Plus } from "lucide-react";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  cancellationLabel,
  DEFAULT_LATE_CANCELLATION_HOURS,
  PATIENT_HISTORY_DAYS,
  patientCancellationStats,
  patientHistoryStart,
} from "@/lib/domain/cancellation";
import {
  DIRECTION_LABELS,
  MOBILITY_LABELS,
  PRESCRIBED_MODE_LABELS,
  RECURRENCE_LEGS_LABELS,
  SHARING_SCOPE_LABELS,
  SHARING_STATUS_LABELS,
  TRIP_STATUS_LABELS,
} from "@/lib/labels";
import { addDays, formatDuration, formatMinute, formatShortDate, fromIsoDate, todayIso, toIsoDate, WEEKDAY_LABELS } from "@/lib/time";
import { formatCoordinate } from "@/components/address/address-utils";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/layout";
import { TBody, Td, Th, THead } from "@/components/ui/table";
import { attachRecurrencesToRenewal, deletePrescription, setPatientActive, setRecurrenceActive } from "../actions";
import { ActionButton } from "../_components/action-button";
import { BackLink } from "../_components/back-link";
import { SyncNotice } from "../_components/sync-notice";
import { Warning } from "../_components/warning";
import {
  findRenewal,
  formatWeekdays,
  mobilityModeWarning,
  needsRenewal,
  prescriptionValidity,
  recurrenceCoverageNotice,
  validityLabel,
  type Notice,
  type ValidityState,
} from "../_lib/status";
import { countOpenTripsByRecurrence } from "../_lib/trip-counts";
import { openTripsLabel } from "../_lib/trip-sync";

export const metadata: Metadata = { title: "Fiche patient" };

const UPCOMING_DAYS = 7;

const VALIDITY_TONES: Record<ValidityState, BadgeTone> = {
  valid: "success",
  upcoming: "info",
  expiring: "danger",
  expired: "danger",
};

const TRIP_STATUS_TONES: Record<TripStatus, BadgeTone> = {
  PLANNED: "neutral",
  ASSIGNED: "brand",
  PICKED_UP: "info",
  DROPPED_OFF: "success",
  CANCELLED: "neutral",
  NO_SHOW: "warning",
};

/** " et ses 4 courses à venir non commencées seront annulées (…)" (empty when there is none). */
function cancelledTripsClause(count: number): string {
  if (count === 0) return "";
  const what =
    count === 1
      ? " et sa course à venir non commencée sera annulée"
      : ` et ses ${openTripsLabel(count)} non commencées seront annulées`;
  return `${what} (sauf une course d'aujourd'hui déjà dans une tournée : à traiter dans Courses)`;
}

export default async function PatientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("REGULATOR");
  const { id } = await params;
  const query = await searchParams;
  const today = todayIso();
  const lastDay = addDays(today, UPCOMING_DAYS - 1);

  const [patient, trips, openTrips, pastTrips] = await Promise.all([
    db.patient.findUnique({
      where: { id },
      include: {
        prescriptions: {
          orderBy: [{ validTo: "desc" }, { validFrom: "desc" }],
          include: { _count: { select: { recurrences: true, trips: true } } },
        },
        recurrences: {
          orderBy: [{ active: "desc" }, { appointmentMinute: "asc" }],
          include: {
            facility: { select: { id: true, name: true, city: true, active: true } },
            prescription: { select: { id: true, mode: true, validFrom: true, validTo: true } },
          },
        },
      },
    }),
    db.trip.findMany({
      where: { patientId: id, serviceDate: { gte: fromIsoDate(today), lte: fromIsoDate(lastDay) } },
      orderBy: [{ serviceDate: "asc" }, { direction: "asc" }],
      include: { facility: { select: { name: true } } },
    }),
    countOpenTripsByRecurrence({ patientId: id }, today),
    // Absences and cancellations of the last days (PATIENT_HISTORY_DAYS), counted on the record.
    db.trip.findMany({
      where: {
        patientId: id,
        serviceDate: { gte: fromIsoDate(patientHistoryStart(today)), lte: fromIsoDate(today) },
        status: { in: ["NO_SHOW", "CANCELLED"] },
      },
      select: { status: true, cancellationOrigin: true, cancellationReason: true, lateCancellation: true },
    }),
  ]);
  if (!patient) notFound();
  // Health data shown: the read is traced (never breaks the page).
  await auditRead(user, { action: "patient.view", entity: "Patient", entityId: patient.id });
  // Read only: a page never creates the settings row.
  const settings = await db.appSettings.findUnique({ where: { id: 1 }, select: { lateCancellationHours: true } });
  const lateHours = settings?.lateCancellationHours ?? DEFAULT_LATE_CANCELLATION_HOURS;

  const prescriptions = patient.prescriptions.map((p) => {
    const dates = { validFrom: toIsoDate(p.validFrom), validTo: toIsoDate(p.validTo) };
    const renewal = findRenewal(p, patient.prescriptions);
    return {
      ...p,
      dates,
      validity: prescriptionValidity(dates, today),
      mismatch: mobilityModeWarning(patient.mobility, p.mode),
      renewal: renewal ? { id: renewal.id, validFrom: toIsoDate(renewal.validFrom), validTo: toIsoDate(renewal.validTo) } : null,
    };
  });
  const prescriptionById = new Map(prescriptions.map((p) => [p.id, p]));
  // Prescriptions ending soon (or ended) whose recurrences can move to the registered renewal.
  const toReattach = prescriptions.filter(
    (p) => p.renewal && p._count.recurrences > 0 && needsRenewal(p.dates, today),
  );
  const totalOpenTrips = [...openTrips.values()].reduce((sum, n) => sum + n, 0);
  const hasValidToday = prescriptions.some((p) => p.validity.state === "valid" || p.validity.state === "expiring");
  const activeRecurrences = patient.recurrences.filter((r) => r.active);
  const sortedTrips = [...trips].sort(
    (a, b) =>
      toIsoDate(a.serviceDate).localeCompare(toIsoDate(b.serviceDate)) ||
      (a.plannedPickupMinute ?? a.appointmentMinute ?? a.readyMinute ?? 0) -
        (b.plannedPickupMinute ?? b.appointmentMinute ?? b.readyMinute ?? 0),
  );
  const fullName = `${patient.lastName.toUpperCase()} ${patient.firstName}`;
  const history = patientCancellationStats(pastTrips);

  return (
    <div className="space-y-6">
      <div>
        <BackLink href="/patients">Patients</BackLink>
        <PageHeader
          title={
            <span className="flex flex-wrap items-center gap-3">
              {fullName}
              <Badge tone={patient.active ? "success" : "neutral"}>{patient.active ? "Actif" : "Inactif"}</Badge>
            </span>
          }
          description={`${patient.city} · ${MOBILITY_LABELS[patient.mobility]}`}
          actions={
            <>
              <LinkButton href={`/patients/${patient.id}/modifier`} size="sm">
                <Pencil aria-hidden className="size-4" />
                Modifier
              </LinkButton>
              <ActionButton
                action={setPatientActive}
                fields={{ patientId: patient.id, active: patient.active ? "false" : "true" }}
                confirmMessage={
                  patient.active
                    ? `Désactiver ${fullName} ? Ses récurrences ne généreront plus de courses${cancelledTripsClause(totalOpenTrips)}. L'historique est conservé.`
                    : undefined
                }
                variant={patient.active ? "secondary" : "primary"}
              >
                {patient.active ? "Désactiver" : "Réactiver"}
              </ActionButton>
            </>
          }
        />
        <div className="space-y-2">
          <SyncNotice query={query} />
          {!patient.active ? (
            <Warning tone="info">
              Patient désactivé : ses récurrences ne génèrent plus de courses. Sa fiche et son historique sont conservés.
            </Warning>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader title="Fiche patient" />
        <CardBody>
          <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Item label="Téléphone">
              {patient.phone ? (
                <a href={`tel:${patient.phone.replace(/[^+\d]/g, "")}`} className="tabular text-brand-800 hover:underline">
                  {patient.phone}
                </a>
              ) : (
                <span className="text-slate-400">Non renseigné</span>
              )}
            </Item>
            <Item label="Mobilité">{MOBILITY_LABELS[patient.mobility]}</Item>
            <Item label="Domicile" className="sm:col-span-2">
              {patient.address}
              <br />
              <span className="tabular">{patient.postalCode}</span> {patient.city}
              <span className="tabular mt-0.5 block text-xs text-slate-500">
                {formatCoordinate(patient.lat)}, {formatCoordinate(patient.lng)}
              </span>
            </Item>
            <Item label={`Sur ${PATIENT_HISTORY_DAYS} jours`} className="sm:col-span-2 lg:col-span-4">
              <span className="tabular flex flex-wrap gap-x-3 gap-y-1">
                <span className={history.noShows > 0 ? "font-medium text-red-800" : undefined}>
                  {history.noShows} absence{history.noShows > 1 ? "s" : ""} (patient absent)
                </span>
                <span aria-hidden className="text-slate-300">·</span>
                <span className={history.lateCancellations > 0 ? "font-medium text-amber-800" : undefined}>
                  {history.lateCancellations} annulation{history.lateCancellations > 1 ? "s" : ""} tardive
                  {history.lateCancellations > 1 ? "s" : ""}
                </span>
                <span aria-hidden className="text-slate-300">·</span>
                <span>
                  {history.cancellations} annulation{history.cancellations > 1 ? "s" : ""} en tout
                </span>
              </span>
              <span className="mt-0.5 block text-xs text-slate-500">
                Annulations demandées pour le patient ; tardive : moins de {lateHours} h avant la prise en charge prévue.
              </span>
            </Item>
            <Item label="Notes d'accès" className="sm:col-span-2 lg:col-span-4">
              {patient.accessNotes ? (
                <span className="whitespace-pre-line">{patient.accessNotes}</span>
              ) : (
                <span className="text-slate-400">Aucune</span>
              )}
            </Item>
          </dl>
        </CardBody>
      </Card>

      {/* ------------------------------------------------------------ prescriptions */}
      <Card id="prescriptions" className="scroll-mt-6">
        <CardHeader
          title={`Prescriptions (${prescriptions.length})`}
          actions={
            <LinkButton href={`/patients/${patient.id}/prescriptions/nouvelle`} size="sm" variant="primary">
              <Plus aria-hidden className="size-4" />
              Ajouter une prescription
            </LinkButton>
          }
        />
        {prescriptions.length === 0 ? (
          <CardBody>
            <p className="text-sm text-slate-600">
              Aucune prescription : saisissez la PMT du patient avant de créer ses récurrences.
            </p>
          </CardBody>
        ) : (
          <>
            {(!hasValidToday && activeRecurrences.length > 0) ||
            prescriptions.some((p) => p.mismatch) ||
            toReattach.length > 0 ? (
              <div className="space-y-2 border-b border-slate-200 px-4 py-3">
                {!hasValidToday && activeRecurrences.length > 0 ? (
                  <Warning tone="danger">
                    Aucune prescription valide aujourd&apos;hui : les récurrences de ce patient ne génèrent pas de courses.
                  </Warning>
                ) : null}
                {prescriptions
                  .filter((p) => p.mismatch)
                  .map((p) => (
                    <Warning key={p.id}>
                      Prescription du {formatShortDate(p.dates.validFrom)} au {formatShortDate(p.dates.validTo)} : {p.mismatch}
                    </Warning>
                  ))}
                {toReattach.map((p) =>
                  p.renewal ? (
                    <div
                      key={p.id}
                      className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900"
                    >
                      <p className="min-w-0 flex-1">
                        {`La prescription du ${formatShortDate(p.dates.validFrom)} au ${formatShortDate(p.dates.validTo)} est renouvelée par celle du ${formatShortDate(p.renewal.validFrom)} au ${formatShortDate(p.renewal.validTo)}, mais ${
                          p._count.recurrences === 1
                            ? "1 récurrence y est encore rattachée"
                            : `${p._count.recurrences} récurrences y sont encore rattachées`
                        } : sans rattachement, plus de course après le ${formatShortDate(p.dates.validTo)}.`}
                      </p>
                      <ActionButton
                        action={attachRecurrencesToRenewal}
                        fields={{ patientId: patient.id, fromPrescriptionId: p.id, toPrescriptionId: p.renewal.id }}
                        confirmMessage={`Rattacher ${p._count.recurrences === 1 ? "la récurrence" : `les ${p._count.recurrences} récurrences`} à la prescription du ${formatShortDate(p.renewal.validFrom)} au ${formatShortDate(p.renewal.validTo)} ? Les courses jusqu'au ${formatShortDate(p.dates.validTo)} sont d'abord générées sur la prescription actuelle.`}
                        variant="secondary"
                        pendingLabel="Rattachement…"
                      >
                        Rattacher au renouvellement
                      </ActionButton>
                    </div>
                  ) : null,
                )}
              </div>
            ) : null}
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <THead>
                  <tr>
                    <Th>Mode</Th>
                    <Th>Partage autorisé</Th>
                    <Th>Validité</Th>
                    <Th>État</Th>
                    <Th>Prescripteur</Th>
                    <Th>Utilisation</Th>
                    <Th className="text-right">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </THead>
                <TBody>
                  {prescriptions.map((p) => (
                    <tr key={p.id} className="align-top">
                      <Td className="whitespace-nowrap">
                        {PRESCRIBED_MODE_LABELS[p.mode]}
                        {p.isSeries ? (
                          <Badge tone="brand" className="ml-2">
                            Série
                          </Badge>
                        ) : null}
                        {p.mismatch ? (
                          <Badge tone="warning" className="ml-2">
                            Incohérente
                          </Badge>
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {p.mode === "AMBULANCE" ? (
                          <span className="text-slate-500">Sans objet</span>
                        ) : (
                          SHARING_SCOPE_LABELS[p.sharing]
                        )}
                      </Td>
                      <Td className="tabular whitespace-nowrap">
                        {formatShortDate(p.dates.validFrom)} → {formatShortDate(p.dates.validTo)}
                      </Td>
                      <Td>
                        {p.renewal && needsRenewal(p.dates, today) ? (
                          <>
                            <Badge tone="neutral" className="tabular whitespace-nowrap">
                              {validityLabel(p.dates, today)} · renouvelée
                            </Badge>
                            <span className="tabular mt-0.5 block text-xs whitespace-nowrap text-slate-500">
                              suite : {formatShortDate(p.renewal.validFrom)} → {formatShortDate(p.renewal.validTo)}
                            </span>
                          </>
                        ) : (
                          <Badge tone={VALIDITY_TONES[p.validity.state]} className="tabular whitespace-nowrap">
                            {validityLabel(p.dates, today)}
                          </Badge>
                        )}
                      </Td>
                      <Td>
                        {p.prescriber ?? <span className="text-slate-400">—</span>}
                        {p.notes ? <p className="mt-0.5 max-w-xs text-xs whitespace-pre-line text-slate-500">{p.notes}</p> : null}
                      </Td>
                      <Td className="tabular text-xs whitespace-nowrap text-slate-600">
                        {p._count.recurrences} récurrence{p._count.recurrences > 1 ? "s" : ""}
                        <br />
                        {p._count.trips} course{p._count.trips > 1 ? "s" : ""}
                      </Td>
                      <Td>
                        <div className="flex items-start justify-end gap-1">
                          <LinkButton
                            href={`/patients/${patient.id}/prescriptions/${p.id}/modifier`}
                            size="sm"
                            variant="ghost"
                            aria-label={`Modifier la prescription du ${formatShortDate(p.dates.validFrom)}`}
                          >
                            Modifier
                          </LinkButton>
                          <ActionButton
                            action={deletePrescription}
                            fields={{ patientId: patient.id, prescriptionId: p.id }}
                            confirmMessage={`Supprimer définitivement la prescription du ${formatShortDate(p.dates.validFrom)} au ${formatShortDate(p.dates.validTo)} ?`}
                            variant="ghost"
                            pendingLabel="Suppression…"
                          >
                            <span className="text-red-700">Supprimer</span>
                          </ActionButton>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </TBody>
              </table>
            </div>
          </>
        )}
      </Card>

      {/* ------------------------------------------------------------ recurrences */}
      <Card id="recurrences" className="scroll-mt-6">
        <CardHeader
          title={`Récurrences (${activeRecurrences.length} active${activeRecurrences.length > 1 ? "s" : ""})`}
          actions={
            prescriptions.length > 0 ? (
              <LinkButton href={`/patients/${patient.id}/recurrences/nouvelle`} size="sm" variant="primary">
                <Plus aria-hidden className="size-4" />
                Ajouter une récurrence
              </LinkButton>
            ) : null
          }
        />
        {patient.recurrences.length === 0 ? (
          <CardBody>
            <p className="text-sm text-slate-600">
              {prescriptions.length === 0
                ? "Ajoutez d'abord une prescription : chaque récurrence s'appuie sur une prescription."
                : "Aucune récurrence. Exemple : dialyse lundi, mercredi, vendredi, RDV 07:30, séance de 4 h."}
            </p>
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <THead>
                <tr>
                  <Th>Jours et RDV</Th>
                  <Th>Établissement</Th>
                  <Th>Séance</Th>
                  <Th>Trajets</Th>
                  <Th>Période</Th>
                  <Th>Statut</Th>
                  <Th className="text-right">
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </THead>
              <TBody>
                {patient.recurrences.map((r) => {
                  const start = toIsoDate(r.startDate);
                  const end = r.endDate ? toIsoDate(r.endDate) : null;
                  const prescriptionDates = {
                    validFrom: toIsoDate(r.prescription.validFrom),
                    validTo: toIsoDate(r.prescription.validTo),
                  };
                  const warnings: Notice[] = [];
                  if (r.active) {
                    const coverage = recurrenceCoverageNotice(
                      { startDate: start, endDate: end },
                      prescriptionDates,
                      today,
                      prescriptionById.get(r.prescription.id)?.renewal ?? null,
                    );
                    if (coverage) warnings.push(coverage);
                    if (!r.facility.active) {
                      warnings.push({ tone: "warning", text: `L'établissement « ${r.facility.name} » est désactivé.` });
                    }
                    if (end !== null && end < today) {
                      warnings.push({ tone: "warning", text: `Récurrence terminée le ${formatShortDate(end)}.` });
                    }
                  }
                  return (
                    <tr key={r.id} className={r.active ? "align-top" : "align-top text-slate-500"}>
                      <Td>
                        <span className="tabular font-medium whitespace-nowrap" title={r.weekdays.map((d) => WEEKDAY_LABELS[d]).join(", ")}>
                          {formatWeekdays(r.weekdays)} · {formatMinute(r.appointmentMinute)}
                        </span>
                        {r.label ? <span className="block text-xs text-slate-600">{r.label}</span> : null}
                        {warnings.length > 0 ? (
                          <div className="mt-1.5 max-w-md space-y-1">
                            {warnings.map((w) => (
                              <Warning key={w.text} tone={w.tone}>
                                {w.text}
                              </Warning>
                            ))}
                          </div>
                        ) : null}
                      </Td>
                      <Td>
                        <Link
                          href={`/etablissements/${r.facility.id}`}
                          className="underline-offset-2 hover:text-brand-800 hover:underline"
                        >
                          {r.facility.name}
                        </Link>
                        <span className="block text-xs text-slate-500">{r.facility.city}</span>
                      </Td>
                      <Td className="tabular whitespace-nowrap">
                        {formatDuration(r.sessionMinutes)}
                        {r.legs !== "OUTBOUND" ? (
                          <span className="block text-xs text-slate-500">
                            fin {formatMinute(r.appointmentMinute + r.sessionMinutes)}
                          </span>
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap">{RECURRENCE_LEGS_LABELS[r.legs]}</Td>
                      <Td className="tabular whitespace-nowrap">
                        {end ? `${formatShortDate(start)} → ${formatShortDate(end)}` : `Depuis le ${formatShortDate(start)}`}
                        <span className="block text-xs text-slate-500">
                          {PRESCRIBED_MODE_LABELS[r.prescription.mode]}, PMT jusqu&apos;au {formatShortDate(prescriptionDates.validTo)}
                        </span>
                      </Td>
                      <Td>
                        <Badge tone={r.active ? "success" : "neutral"}>{r.active ? "Active" : "Inactive"}</Badge>
                      </Td>
                      <Td>
                        <div className="flex items-start justify-end gap-1">
                          <LinkButton
                            href={`/patients/${patient.id}/recurrences/${r.id}/modifier`}
                            size="sm"
                            variant="ghost"
                            aria-label={`Modifier la récurrence ${formatWeekdays(r.weekdays)} ${formatMinute(r.appointmentMinute)}`}
                          >
                            Modifier
                          </LinkButton>
                          <ActionButton
                            action={setRecurrenceActive}
                            fields={{ patientId: patient.id, recurrenceId: r.id, active: r.active ? "false" : "true" }}
                            confirmMessage={
                              r.active
                                ? `Désactiver cette récurrence ? Elle ne générera plus de courses${cancelledTripsClause(openTrips.get(r.id) ?? 0)}.`
                                : undefined
                            }
                            variant="ghost"
                          >
                            {r.active ? "Désactiver" : "Réactiver"}
                          </ActionButton>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </TBody>
            </table>
          </div>
        )}
      </Card>

      {/* ------------------------------------------------------------ upcoming trips */}
      <Card id="courses">
        <CardHeader
          title={`Prochaines courses (${UPCOMING_DAYS} jours)`}
          actions={
            <span className="tabular text-xs text-slate-500">
              {formatShortDate(today)} → {formatShortDate(lastDay)}
            </span>
          }
        />
        {sortedTrips.length === 0 ? (
          <CardBody>
            <p className="text-sm text-slate-600">
              Aucune course prévue sur les {UPCOMING_DAYS} prochains jours. Les courses régulières apparaissent une fois
              générées depuis les récurrences.
            </p>
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
            <THead>
              <tr>
                <Th>Date</Th>
                <Th>Sens</Th>
                <Th>Horaire</Th>
                <Th>Établissement</Th>
                <Th>Statut</Th>
                <Th>Partage</Th>
              </tr>
            </THead>
            <TBody>
              {sortedTrips.map((t) => {
                const date = toIsoDate(t.serviceDate);
                return (
                  <tr key={t.id}>
                    <Td className="tabular whitespace-nowrap">
                      {formatShortDate(date)}
                      {date === today ? <span className="ml-1.5 text-xs text-slate-500">aujourd&apos;hui</span> : null}
                    </Td>
                    <Td>{DIRECTION_LABELS[t.direction]}</Td>
                    <Td className="tabular whitespace-nowrap">
                      {t.direction === "OUTBOUND"
                        ? `RDV ${formatMinute(t.appointmentMinute)}`
                        : `Fin de séance ${formatMinute(t.readyMinute)}`}
                      {t.plannedPickupMinute !== null ? (
                        <span className="block text-xs text-slate-500">
                          prise en charge {formatMinute(t.plannedPickupMinute)}
                        </span>
                      ) : null}
                    </Td>
                    <Td>{t.facility?.name ?? <span className="text-slate-400">—</span>}</Td>
                    <Td>
                      <Badge tone={TRIP_STATUS_TONES[t.status]}>{TRIP_STATUS_LABELS[t.status]}</Badge>
                      {t.status === "CANCELLED" ? (
                        <span className="mt-0.5 block text-xs text-slate-500">{cancellationLabel(t)}</span>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {t.shared ? (
                        <Badge tone="brand" className="mr-1.5">
                          Partagée
                        </Badge>
                      ) : null}
                      <span className={t.sharingStatus === "REFUSED" ? "font-medium text-red-700" : "text-slate-700"}>
                        {SHARING_STATUS_LABELS[t.sharingStatus]}
                      </span>
                    </Td>
                  </tr>
                );
              })}
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
