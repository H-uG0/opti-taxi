import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/layout";
import { TBody, THead, Table, Td, Th } from "@/components/ui/table";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/domain/settings";
import { certifiedOn } from "@/lib/domain/tariffs";
import { AREA_KIND_LABELS, AREA_RULE_LABELS } from "@/lib/domain/tariff-areas";
import { formatLongDate, formatShortDate, fromIsoDate, todayIso, tomorrowIso, toIsoDate } from "@/lib/time";
import { VERIFICATION_LABELS, VERIFICATION_TONES } from "../schema";
import {
  addCertification,
  addHoliday,
  addLegalHolidays,
  deleteCertification,
  deleteHoliday,
  saveBillingSettings,
} from "./actions";
import { AddRowForm, BillingSettingsForm, RowAction } from "./forms";
import { BackLink } from "@/components/ui/back-link";
import { Notice } from "@/components/ui/notice";
import { PENDING_LABEL } from "@/lib/forms";

export const metadata: Metadata = { title: "Règles de facturation" };

function period(from: Date | null, to: Date | null): string {
  if (!from && !to) return "toujours";
  if (!from) return `jusqu'au ${formatShortDate(toIsoDate(to!))}`;
  const start = formatShortDate(toIsoDate(from));
  return to ? `du ${start} au ${formatShortDate(toIsoDate(to))}` : `depuis le ${start}`;
}

export default async function BillingRulesPage() {
  await requireUser("REGULATOR");
  const today = todayIso();
  const year = Number(today.slice(0, 4));
  const [settings, certifications, areas, holidays] = await Promise.all([
    getSettings(db),
    db.companyCertification.findMany({ orderBy: { validFrom: "desc" } }),
    db.tariffArea.findMany({ orderBy: [{ kind: "asc" }, { name: "asc" }] }),
    db.publicHoliday.findMany({ where: { date: { gte: fromIsoDate(`${year}-01-01`) } }, orderBy: { date: "asc" } }),
  ]);
  const certifiedTomorrow = certifiedOn(certifications, tomorrowIso());
  const years = [year, year + 1];

  return (
    <div className="max-w-5xl">
      <BackLink href="/tarifs">Grilles tarifaires</BackLink>
      <PageHeader
        title="Règles de facturation"
        description="Ce qui choisit la grille de chaque véhicule, et les lectures des conventions retenues en attendant la confirmation de votre CPAM."
      />

      <div className="space-y-6">
        <Card>
          <CardHeader
            title="Certification de l'entreprise"
            actions={<Badge tone={certifiedTomorrow ? "success" : "warning"}>{certifiedTomorrow ? "Certifiée demain" : "Non certifiée demain"}</Badge>}
          />
          <CardBody className="space-y-4 text-sm text-slate-700">
            <p>
              Une entreprise est certifiée quand tous ses véhicules ont une géolocalisation certifiée par l&apos;Assurance maladie et
              qu&apos;elle facture par SEFi. Ses VSL et ses ambulances relèvent alors des grilles majorées (forfaits plus élevés et,
              en VSL, abattements de partage plus faibles : montants dans{" "}
              <Link href="/tarifs" className="font-medium text-brand-700 underline underline-offset-2">
                Grilles tarifaires
              </Link>
              ), sinon des grilles socle. Les taxis n&apos;en dépendent pas.
            </p>
            {certifications.length > 0 ? (
              <Table>
                <THead>
                  <tr>
                    <Th>Période</Th>
                    <Th>Note</Th>
                    <Th>
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </THead>
                <TBody>
                  {certifications.map((c) => (
                    <tr key={c.id}>
                      <Td className="tabular whitespace-nowrap">{period(c.validFrom, c.validTo)}</Td>
                      <Td className="text-slate-600">{c.note ?? "—"}</Td>
                      <Td className="w-56 text-right">
                        <ConfirmAction
                          action={deleteCertification.bind(null, c.id)}
                          label="Supprimer"
                          ariaLabel={`Supprimer la période de certification ${period(c.validFrom, c.validTo)}`}
                          confirmLabel="Oui, supprimer la période"
                          keepLabel="Garder la période"
                          question={<p>Les calculs à venir sur ces dates prendront les grilles socle des VSL et des ambulances.</p>}
                        />
                      </Td>
                    </tr>
                  ))}
                </TBody>
              </Table>
            ) : (
              <p className="text-slate-500">Aucune période : l&apos;entreprise est considérée comme non certifiée.</p>
            )}
            <AddRowForm
              action={addCertification}
              submitLabel="Ajouter la période"
              fields={[
                { name: "validFrom", label: "Certifiée à partir du", type: "date", required: true },
                { name: "validTo", label: "Jusqu'au (facultatif)", type: "date" },
                { name: "note", label: "Note (facultatif)", width: "min-w-64 flex-1" },
              ]}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Siège et lecture des conventions" />
          <CardBody className="space-y-4">
            <Notice tone="warning" title="Lectures à confirmer">
              <p>
                Ces réglages tranchent des points que les conventions laissent ouverts, en attendant la confirmation de la CPAM. Ils
                changent le chiffre d&apos;affaires estimé des tournées à partir du prochain calcul.
              </p>
            </Notice>
            <BillingSettingsForm
              action={saveBillingSettings}
              initial={{
                hqDepartment: settings.hqDepartment ?? "",
                hqCity: settings.hqCity ?? "",
                emptyLegRule: settings.emptyLegRule,
                surchargeOrder: settings.surchargeOrder,
                sharedPatientCount: settings.sharedPatientCount,
              }}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Zones tarifaires"
            actions={
              <LinkButton href="/tarifs/regles/zones/nouvelle" size="sm" variant="secondary">
                <Plus aria-hidden className="size-3.5" />
                Nouvelle zone
              </LinkButton>
            }
          />
          <CardBody className="space-y-3 text-sm text-slate-700">
            <p>
              Taxi : forfait « Grande ville » quand le patient est pris en charge ou déposé dans la zone. Ambulance : forfait
              agglomération pour un transport dans l&apos;agglomération où l&apos;entreprise a son siège. La commune d&apos;une course est
              lue dans son adresse.
            </p>
            <Table>
              <THead>
                <tr>
                  <Th>Zone</Th>
                  <Th>Communes</Th>
                  <Th>Règle</Th>
                  <Th>Validité</Th>
                </tr>
              </THead>
              <TBody>
                {areas.map((area) => (
                  <tr key={area.id} className="align-top">
                    <Td className="max-w-56">
                      <Link href={`/tarifs/regles/zones/${area.id}`} className="font-medium text-slate-900 underline-offset-2 hover:text-brand-700 hover:underline">
                        {area.name}
                      </Link>
                      <span className="mt-0.5 flex flex-wrap gap-1.5">
                        <Badge tone="neutral">{AREA_KIND_LABELS[area.kind]}</Badge>
                        <Badge tone={VERIFICATION_TONES[area.verification]}>{VERIFICATION_LABELS[area.verification]}</Badge>
                      </span>
                    </Td>
                    <Td className="max-w-72 text-xs text-slate-600">
                      {area.hubCommune ? <span className="font-medium text-slate-800">{area.hubCommune} (centre) · </span> : null}
                      {area.communes.join(", ")}
                    </Td>
                    <Td className="text-xs">{AREA_RULE_LABELS[area.rule]}</Td>
                    <Td className="tabular text-xs whitespace-nowrap">{period(area.validFrom, area.validTo)}</Td>
                  </tr>
                ))}
              </TBody>
            </Table>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Jours fériés" />
          <CardBody className="space-y-4 text-sm text-slate-700">
            <p>
              Majoration « dimanche et jour férié » : aucune convention ne fixe la liste. Par défaut, les 11 jours fériés légaux ;
              ajoutez ceux que votre CPAM retiendrait en plus.
            </p>
            <div className="flex flex-wrap gap-2">
              {years.map((y) => (
                <RowAction key={y} action={addLegalHolidays.bind(null, y)} label={`Ajouter les jours fériés légaux de ${y}`} pendingLabel={PENDING_LABEL} />
              ))}
            </div>
            {holidays.length > 0 ? (
              <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                {holidays.map((h) => {
                  const iso = toIsoDate(h.date);
                  return (
                    <li key={iso} className="flex items-start justify-between gap-2 border-b border-slate-100 py-1">
                      <span className="pt-1">
                        <span className="tabular font-medium text-slate-900">{formatLongDate(iso)}</span>{" "}
                        <span className="text-slate-500">· {h.label}</span>
                      </span>
                      <ConfirmAction
                        action={deleteHoliday.bind(null, iso)}
                        label="Retirer"
                        ariaLabel={`Retirer le ${formatLongDate(iso)} des jours fériés`}
                        confirmLabel="Oui, retirer le jour"
                        keepLabel="Garder le jour férié"
                        question={<p>La majoration « dimanche et jour férié » ne s&apos;appliquera plus ce jour-là aux prochains calculs.</p>}
                      />
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-slate-500">Aucun jour férié à venir dans la liste.</p>
            )}
            <AddRowForm
              action={addHoliday}
              submitLabel="Ajouter le jour"
              fields={[
                { name: "date", label: "Date", type: "date", required: true },
                { name: "label", label: "Libellé", required: true, width: "min-w-64 flex-1" },
              ]}
            />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
