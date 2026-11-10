import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { compareLabels } from "@/lib/fleet/order";
import { MOBILITY_LABELS, PRESCRIBED_MODE_LABELS } from "@/lib/labels";
import { filterHref, pageOf } from "@/lib/list-filters";
import { formatShortDate, todayIso, toIsoDate } from "@/lib/time";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { FilterBar, FilterSearch, FilterSelect } from "@/components/ui/filter-bar";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { Pagination } from "@/components/ui/pagination";
import { Table, TBody, Td, Th, THead } from "@/components/ui/table";
import {
  isFiltered,
  MOBILITIES,
  parsePatientFilter,
  PATIENT_PAGE_SIZE,
  patientOrderBy,
  patientParams,
  patientWhere,
  PRESCRIPTION_FILTERS,
  SORTS,
  STATUS_FILTERS,
  type StatusFilter,
} from "./_lib/list-filter";
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

const SORT_PHRASES: Record<keyof typeof SORTS, string> = {
  nom: "par nom",
  "nom-desc": "par nom, de Z à A",
  ville: "par ville",
  recent: "du plus récent au plus ancien",
};

function describeResults(total: number, status: StatusFilter, q: string): string {
  if (total === 0) return "Aucun patient pour ces critères.";
  const plural = total > 1 ? "s" : "";
  const adjective = status === "actifs" ? ` actif${plural}` : status === "inactifs" ? ` inactif${plural}` : "";
  return `${new Intl.NumberFormat("fr-FR").format(total)} patient${plural}${adjective}${q ? ` correspondant à « ${q} »` : ""}`;
}

export default async function PatientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("REGULATOR");
  const params = await searchParams;
  const filter = parsePatientFilter(params);
  const today = todayIso();
  const where = patientWhere(filter, today);

  const [total, facilities] = await Promise.all([
    db.patient.count({ where }),
    db.facility.findMany({ where: { active: true }, select: { id: true, name: true } }),
  ]);
  const { page, pageCount, skip } = pageOf(params, total, PATIENT_PAGE_SIZE);
  // Mobility, prescriptions and care schedules of many patients are on screen (auditRead never throws).
  const traced = auditRead(user, { action: "patient_list.view", entity: "Patient", entityId: null });
  const patients = await db.patient.findMany({
    where,
    orderBy: patientOrderBy(filter.sort),
    skip,
    take: PATIENT_PAGE_SIZE,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      city: true,
      postalCode: true,
      mobility: true,
      active: true,
      prescriptions: {
        select: {
          id: true,
          mode: true,
          validFrom: true,
          validTo: true,
          // Facilities of the active recurrences: another series' PMT is never taken for a renewal.
          recurrences: { where: { active: true }, select: { facilityId: true } },
        },
      },
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
  });
  await traced;

  const filtered = isFiltered(filter);
  const hrefOf = (target: number) => filterHref("/patients", { ...patientParams(filter), page: target > 1 ? target : null });
  const first = skip + 1;
  const last = skip + patients.length;

  return (
    <div>
      <PageHeader
        title="Patients"
        description={describeResults(total, filter.status, filter.q)}
        actions={
          <LinkButton href="/patients/nouveau" variant="primary">
            <Plus aria-hidden className="size-4" />
            Nouveau patient
          </LinkButton>
        }
      />

      <FilterBar action="/patients" label="Rechercher un patient" resetHref="/patients" filtered={filtered} submitLabel="Rechercher" className="mb-4">
        <FilterSearch defaultValue={filter.q} placeholder="Nom, prénom, ville, CP ou téléphone" className="sm:w-80" />
        <FilterSelect
          name="statut"
          label="Statut"
          value={filter.status}
          defaultChoice="actifs"
          options={Object.entries(STATUS_FILTERS).map(([value, label]) => ({ value, label }))}
          className="w-32"
        />
        <FilterSelect
          name="pmt"
          label="Prescription"
          value={filter.prescription ?? ""}
          allLabel="Toutes"
          options={Object.entries(PRESCRIPTION_FILTERS).map(([value, label]) => ({ value, label }))}
          className="w-64"
        />
        <FilterSelect
          name="etablissement"
          label="Établissement (série en cours)"
          value={filter.facility ?? ""}
          allLabel="Tous"
          options={[...facilities].sort((a, b) => compareLabels(a.name, b.name)).map((f) => ({ value: f.id, label: f.name }))}
          className="w-64"
        />
        <FilterSelect
          name="mobilite"
          label="Mobilité"
          value={filter.mobility ?? ""}
          allLabel="Toutes"
          options={MOBILITIES.map((m) => ({ value: m, label: MOBILITY_LABELS[m] }))}
          className="w-40"
        />
        <FilterSelect
          name="tri"
          label="Trier par"
          value={filter.sort}
          defaultChoice="nom"
          options={Object.entries(SORTS).map(([value, label]) => ({ value, label }))}
          className="w-48"
        />
      </FilterBar>

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
          {filtered ? "Modifiez la recherche ou les filtres." : "Commencez par créer une fiche patient."}
        </EmptyState>
      ) : (
        <>
          <p className="mb-2 text-sm text-slate-600" aria-live="polite">
            {pageCount > 1 ? `Patients ${first} à ${last} sur ${total}` : `${total} patient${total > 1 ? "s" : ""}`}, {SORT_PHRASES[filter.sort]}.
          </p>
          <Table stickyHeader>
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
                const toAttach = renewed && current ? patient.recurrences.filter((r) => r.prescriptionId === current.id).length : 0;
                return (
                  <tr key={patient.id} className="hover:bg-slate-50">
                    <Td className="whitespace-nowrap">
                      <Link
                        href={`/patients/${patient.id}`}
                        className="font-medium text-slate-900 underline-offset-2 hover:text-brand-800 hover:underline"
                      >
                        <span className="uppercase">{patient.lastName}</span> {patient.firstName}
                      </Link>
                      {patient.phone ? <span className="tabular block text-xs text-slate-500">{patient.phone}</span> : null}
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
                            <Badge tone={toAttach > 0 ? "warning" : "neutral"} className="tabular whitespace-nowrap">
                              {toAttach > 0
                                ? `Renouvelée : ${toAttach > 1 ? "récurrences" : "récurrence"} à rattacher`
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
          <Pagination page={page} pageCount={pageCount} hrefOf={hrefOf} label="Pages de la liste des patients" className="mt-3" />
        </>
      )}
    </div>
  );
}
