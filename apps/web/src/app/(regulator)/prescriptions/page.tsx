import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { PRESCRIBED_MODE_LABELS } from "@/lib/labels";
import { formatShortDate, todayIso } from "@/lib/time";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { Table, TBody, Td, Th, THead } from "@/components/ui/table";
import { attachRecurrencesToRenewal } from "../patients/actions";
import { ActionButton } from "@/components/ui/action-button";
import { EXPIRY_WARNING_DAYS, uncoveredText } from "../patients/_lib/status";
import { countByState, type WorkItem, type WorkState } from "../patients/_lib/work-list";
import { loadPrescriptionWork } from "../patients/_lib/work-list-db";

export const metadata: Metadata = { title: "Prescriptions à traiter" };

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// « Renouvelée, à rattacher » is amber here as on the patients list and the patient page.
const STATE_TONES: Record<WorkState, BadgeTone> = { expired: "danger", expiring: "warning", renewed: "warning" };

function stateLabel(item: WorkItem, today: string): string {
  if (item.state === "renewed") {
    return item.renewal && item.renewal.validFrom > today
      ? `Renouvelée à partir du ${formatShortDate(item.renewal.validFrom)}\u00a0: à rattacher`
      : "Renouvelée\u00a0: à rattacher";
  }
  if (item.state === "expired") return `Expirée le ${formatShortDate(item.prescription.validTo)}`;
  if (item.daysLeft === 0) return "Expire aujourd'hui";
  return item.daysLeft === 1 ? "Expire demain" : `Expire dans ${item.daysLeft} j`;
}

function consequence(item: WorkItem): string {
  if (item.state === "renewed" && item.renewal) {
    const gap = item.uncovered ? ` ${capitalize(uncoveredText(item.uncovered))}.` : "";
    const which = item.recurrences.length > 1 ? "les récurrences" : "la récurrence";
    return `Les courses continuent sur le renouvellement (${formatShortDate(item.renewal.validFrom)} → ${formatShortDate(item.renewal.validTo)})\u202f; rattachez-y ${which}.${gap}`;
  }
  if (item.state === "expired") return "Plus aucune course n'est créée\u00a0: saisissez la nouvelle PMT.";
  return `Plus de course après le ${formatShortDate(item.prescription.validTo)} sans nouvelle PMT.`;
}

function describe(items: readonly WorkItem[]): string {
  if (items.length === 0) return "Aucune prescription à traiter.";
  const counts = countByState(items);
  const parts = [
    counts.expired > 0 ? `${counts.expired} expirée${counts.expired > 1 ? "s" : ""}` : null,
    counts.expiring > 0 ? `${counts.expiring} expirant sous ${EXPIRY_WARNING_DAYS} jours` : null,
    counts.renewed > 0 ? `${counts.renewed} renouvellement${counts.renewed > 1 ? "s" : ""} à rattacher` : null,
  ].filter(Boolean);
  return `${items.length} prescription${items.length > 1 ? "s" : ""} à traiter\u00a0: ${parts.join(", ")}.`;
}

/**
 * Work list of the prescriptions an active recurrence relies on and that end
 * within 14 days (or have ended), or whose renewal is not attached yet
 * (patients/_lib/work-list.ts). Read only; « Rattacher » moves the recurrences.
 */
export default async function PrescriptionsPage() {
  const user = await requireUser("REGULATOR");
  const today = todayIso();
  // Patients' names and treatments are on screen (auditRead never throws).
  const [items] = await Promise.all([
    loadPrescriptionWork(today),
    auditRead(user, { action: "patient_list.view", entity: "Patient", entityId: null }),
  ]);

  return (
    <div>
      <PageHeader title="Prescriptions à traiter" description={describe(items)} />
      <p className="mb-4 max-w-3xl text-sm text-slate-600">
        Prescriptions dont dépend une récurrence active et qui expirent sous {EXPIRY_WARNING_DAYS} jours, ou ont expiré,
        alors que la récurrence continue. Sans PMT valide, un patient régulier n&apos;a plus de course&nbsp;: saisissez le
        renouvellement depuis sa fiche, puis rattachez-y ses récurrences.
      </p>

      {items.length === 0 ? (
        <EmptyState title="Aucune prescription à traiter">
          Toutes les récurrences actives ont une prescription valide au-delà des {EXPIRY_WARNING_DAYS} prochains jours.
        </EmptyState>
      ) : (
        <Table>
          <caption className="sr-only">Prescriptions à traiter</caption>
          <THead>
            <tr>
              <Th>Patient</Th>
              <Th>Prescription</Th>
              <Th>État</Th>
              <Th>Récurrences concernées</Th>
              <Th className="text-right">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {items.map((item) => (
              <tr key={item.prescription.id} className="align-top">
                <Td className="whitespace-nowrap">
                  <Link
                    href={`/patients/${item.patient.id}#prescriptions`}
                    className="font-medium text-slate-900 underline-offset-2 hover:text-brand-800 hover:underline"
                  >
                    {item.patient.name}
                  </Link>
                  <span className="block text-xs text-slate-500">{item.patient.city}</span>
                </Td>
                <Td className="whitespace-nowrap">
                  {PRESCRIBED_MODE_LABELS[item.prescription.mode]}
                  <span className="tabular block text-xs text-slate-500">
                    {formatShortDate(item.prescription.validFrom)} → {formatShortDate(item.prescription.validTo)}
                  </span>
                </Td>
                <Td className="max-w-xs">
                  <Badge tone={STATE_TONES[item.state]} className="tabular whitespace-nowrap">
                    {stateLabel(item, today)}
                  </Badge>
                  <span className="mt-1 block text-xs text-slate-600">{consequence(item)}</span>
                </Td>
                <Td>
                  <ul className="tabular space-y-0.5">
                    {item.recurrences.map((summary) => (
                      <li key={summary} className="whitespace-nowrap">
                        {summary}
                      </li>
                    ))}
                  </ul>
                </Td>
                <Td>
                  <div className="flex justify-end">
                    {item.state === "renewed" && item.renewal ? (
                      <ActionButton
                        action={attachRecurrencesToRenewal}
                        fields={{
                          patientId: item.patient.id,
                          fromPrescriptionId: item.prescription.id,
                          toPrescriptionId: item.renewal.id,
                        }}
                        confirm={{
                          question: `Rattacher ${item.recurrences.length > 1 ? "les récurrences" : "la récurrence"} de ${item.patient.name} à la prescription du ${formatShortDate(item.renewal.validFrom)} au ${formatShortDate(item.renewal.validTo)}\u202f?`,
                          confirmLabel: "Oui, rattacher",
                          tone: "primary",
                        }}
                      >
                        {/* One line, as the « Saisir la nouvelle PMT » buttons of the column. */}
                        <span className="whitespace-nowrap">Rattacher au renouvellement</span>
                      </ActionButton>
                    ) : (
                      <LinkButton href={`/patients/${item.patient.id}/prescriptions/nouvelle`} size="sm">
                        <Plus aria-hidden className="size-4" />
                        Saisir la nouvelle PMT
                      </LinkButton>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
