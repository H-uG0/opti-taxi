import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { Plus, Search } from "lucide-react";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { MOBILITY_LABELS, PRESCRIBED_MODE_LABELS } from "@/lib/labels";
import { formatShortDate, todayIso, toIsoDate } from "@/lib/time";
import { Badge } from "@/components/ui/badge";
import { Button, LinkButton } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { Table, TBody, Td, Th, THead } from "@/components/ui/table";
import {
  findRenewal,
  formatRecurrenceSummary,
  mobilityModeWarning,
  needsRenewal,
  pickCurrentPrescription,
  prescriptionValidity,
  validityLabel,
} from "./_lib/status";

export const metadata: Metadata = { title: "Patients" };

const STATUS_FILTERS = {
  actifs: "Actifs",
  inactifs: "Inactifs",
  tous: "Tous",
} as const;
type StatusFilter = keyof typeof STATUS_FILTERS;

const MAX_ROWS = 300;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function describeResults(total: number, status: StatusFilter, q: string): string {
  if (total === 0) return "Aucun patient pour ces critères.";
  const plural = total > 1 ? "s" : "";
  const adjective = status === "actifs" ? ` actif${plural}` : status === "inactifs" ? ` inactif${plural}` : "";
  return `${total} patient${plural}${adjective}${q ? ` correspondant à « ${q} »` : ""}`;
}

export default async function PatientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("REGULATOR");
  const params = await searchParams;
  const q = first(params.q).trim().slice(0, 100);
  const statusParam = first(params.statut);
  const status: StatusFilter = Object.hasOwn(STATUS_FILTERS, statusParam) ? (statusParam as StatusFilter) : "actifs";
  const today = todayIso();

  // Every word must match the last name, first name or city.
  const terms = q.split(/\s+/).filter(Boolean).slice(0, 5);
  const where: Prisma.PatientWhereInput = {
    ...(status === "tous" ? {} : { active: status === "actifs" }),
    AND: terms.map((term) => ({
      OR: [
        { lastName: { contains: term, mode: "insensitive" as const } },
        { firstName: { contains: term, mode: "insensitive" as const } },
        { city: { contains: term, mode: "insensitive" as const } },
      ],
    })),
  };

  // Mobility, prescriptions and care schedules of many patients are on screen (auditRead never throws).
  const traced = auditRead(user, { action: "patient_list.view", entity: "Patient", entityId: null });
  const [patients, total] = await Promise.all([
    db.patient.findMany({
      where,
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: MAX_ROWS,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        city: true,
        postalCode: true,
        mobility: true,
        active: true,
        prescriptions: { select: { id: true, mode: true, validFrom: true, validTo: true } },
        recurrences: {
          where: { active: true },
          orderBy: { appointmentMinute: "asc" },
          select: {
            id: true,
            weekdays: true,
            appointmentMinute: true,
            label: true,
            prescriptionId: true,
            facility: { select: { name: true } },
          },
        },
      },
    }),
    db.patient.count({ where }),
  ]);
  await traced;

  const filtered = q !== "" || status !== "actifs";

  return (
    <div>
      <PageHeader
        title="Patients"
        description={describeResults(total, status, q)}
        actions={
          <LinkButton href="/patients/nouveau" variant="primary">
            <Plus aria-hidden className="size-4" />
            Nouveau patient
          </LinkButton>
        }
      />

      <Form key={`${q}|${status}`} action="/patients" role="search" className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Rechercher" htmlFor="q" className="w-full sm:w-80">
          <Input id="q" name="q" type="search" defaultValue={q} placeholder="Nom, prénom ou ville" maxLength={100} />
        </Field>
        <Field label="Statut" htmlFor="statut" className="w-40">
          <Select id="statut" name="statut" defaultValue={status}>
            {Object.entries(STATUS_FILTERS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="secondary">
          <Search aria-hidden className="size-4" />
          Rechercher
        </Button>
        {filtered ? (
          <Link href="/patients" className="pb-2.5 text-sm text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline">
            Réinitialiser
          </Link>
        ) : null}
      </Form>

      {patients.length === 0 ? (
        <EmptyState
          title={filtered ? "Aucun patient ne correspond à la recherche" : "Aucun patient enregistré"}
          action={
            filtered ? (
              <LinkButton href="/patients">Voir les patients actifs</LinkButton>
            ) : (
              <LinkButton href="/patients/nouveau" variant="primary">
                Créer le premier patient
              </LinkButton>
            )
          }
        >
          {filtered ? "Modifiez la recherche ou le filtre de statut." : "Commencez par créer une fiche patient."}
        </EmptyState>
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Nom</Th>
                <Th>Ville</Th>
                <Th>Mobilité</Th>
                <Th>Prescription en cours</Th>
                <Th>Récurrences</Th>
                <Th>Statut</Th>
              </tr>
            </THead>
            <TBody>
              {patients.map((patient) => {
                const current = pickCurrentPrescription(patient.prescriptions, today);
                const currentDates = current
                  ? { validFrom: toIsoDate(current.validFrom), validTo: toIsoDate(current.validTo) }
                  : null;
                const validity = currentDates ? prescriptionValidity(currentDates, today) : null;
                const mismatch = current ? mobilityModeWarning(patient.mobility, current.mode) : null;
                const renewal = current ? findRenewal(current, patient.prescriptions) : null;
                const renewed = Boolean(renewal && currentDates && needsRenewal(currentDates, today));
                // Renewed, but active recurrences still on the old prescription: to attach (work list « Prescriptions »).
                const toAttach = renewed && current ? patient.recurrences.some((r) => r.prescriptionId === current.id) : false;
                return (
                  <tr key={patient.id} className="hover:bg-slate-50">
                    <Td className="whitespace-nowrap">
                      <Link
                        href={`/patients/${patient.id}`}
                        className="font-medium text-slate-900 underline-offset-2 hover:text-brand-800 hover:underline"
                      >
                        <span className="uppercase">{patient.lastName}</span> {patient.firstName}
                      </Link>
                    </Td>
                    <Td className="whitespace-nowrap">
                      {patient.city}
                      <span className="tabular ml-1.5 text-xs text-slate-500">{patient.postalCode}</span>
                    </Td>
                    <Td className="whitespace-nowrap">{MOBILITY_LABELS[patient.mobility]}</Td>
                    <Td>
                      {current && currentDates && validity ? (
                        <div className="flex flex-col items-start gap-1">
                          <span className="whitespace-nowrap">{PRESCRIBED_MODE_LABELS[current.mode]}</span>
                          {renewed && renewal ? (
                            <Badge tone={toAttach ? "warning" : "neutral"} className="tabular whitespace-nowrap">
                              {toAttach
                                ? "Renouvelée : récurrences à rattacher"
                                : `Renouvelée jusqu'au ${formatShortDate(toIsoDate(renewal.validTo))}`}
                            </Badge>
                          ) : (
                            <Badge
                              tone={
                                needsRenewal(currentDates, today) ? "danger" : validity.state === "upcoming" ? "info" : "neutral"
                              }
                              className="tabular whitespace-nowrap"
                            >
                              {validity.state === "valid"
                                ? `Jusqu'au ${formatShortDate(currentDates.validTo)}`
                                : validityLabel(currentDates, today)}
                            </Badge>
                          )}
                          {mismatch ? (
                            <Badge tone="warning" className="whitespace-nowrap">
                              <span title={mismatch}>Incohérente avec la mobilité</span>
                            </Badge>
                          ) : null}
                        </div>
                      ) : (
                        <Badge tone="danger">Aucune prescription</Badge>
                      )}
                    </Td>
                    <Td>
                      {patient.recurrences.length === 0 ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <ul className="tabular space-y-0.5">
                          {patient.recurrences.map((r) => (
                            <li key={r.id} className="whitespace-nowrap">
                              {formatRecurrenceSummary({
                                weekdays: r.weekdays,
                                appointmentMinute: r.appointmentMinute,
                                label: r.label,
                                facilityName: r.facility.name,
                              })}
                            </li>
                          ))}
                        </ul>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={patient.active ? "success" : "neutral"}>{patient.active ? "Actif" : "Inactif"}</Badge>
                    </Td>
                  </tr>
                );
              })}
            </TBody>
          </Table>
          {total > patients.length ? (
            <p className="mt-3 text-sm text-slate-600">
              {patients.length} premiers patients affichés sur {total} : affinez la recherche pour voir les autres.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
