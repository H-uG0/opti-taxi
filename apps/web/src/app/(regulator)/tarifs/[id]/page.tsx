import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, VehicleTypeBadge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/layout";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { tariffsInForce } from "@/lib/domain/tariffs";
import { todayIso } from "@/lib/time";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { departmentLabel } from "../../vehicules/_lib/departments";
import { deleteTariff, updateTariff } from "../actions";
import {
  certificationLabel,
  TARIFF_STATUS_LABELS,
  tariffFormValues,
  tariffStatus,
  VERIFICATION_LABELS,
  VERIFICATION_TONES,
} from "../schema";
import { TariffForm } from "../tariff-form";
import { BackLink } from "@/components/ui/back-link";

/** The tab names the record (never a patient: titles stay in the browser history). */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const record = await db.tariffGrid.findUnique({ where: { id }, select: { label: true } });
  return { title: record?.label ?? "Grille tarifaire" };
}

export default async function EditTariffPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cree?: string }>;
}) {
  const { cree } = await searchParams;
  await requireUser("REGULATOR");
  const { id } = await params;
  const grid = await db.tariffGrid.findUnique({ where: { id } });
  if (!grid) notFound();

  // Status needs the sibling grids of the same vehicle type, department and certification.
  const siblings = await db.tariffGrid.findMany({
    where: { vehicleType: grid.vehicleType, department: grid.department, certified: grid.certified },
  });
  const today = todayIso();
  const status = tariffStatus(grid, today, new Set(tariffsInForce(siblings, today).map((g) => g.id)));

  return (
    <div className="max-w-5xl">
      <BackLink href="/tarifs">Grilles tarifaires</BackLink>
      <PageHeader
        title={grid.label ?? "Grille sans libellé"}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <VehicleTypeBadge type={grid.vehicleType} />
            <span>{departmentLabel(grid.department)}</span>
            <span>· {certificationLabel(grid.certified)}</span>
            <Badge tone={status === "IN_FORCE" ? "success" : status === "UPCOMING" ? "info" : "neutral"}>
              {TARIFF_STATUS_LABELS[status]}
            </Badge>
            <Badge tone={VERIFICATION_TONES[grid.verification]}>{VERIFICATION_LABELS[grid.verification]}</Badge>
            {grid.sourceUrl ? (
              <a href={grid.sourceUrl} target="_blank" rel="noreferrer noopener" className="text-sm underline underline-offset-2 hover:text-brand-700">
                Voir la source
              </a>
            ) : null}
          </span>
        }
        actions={
          <LinkButton href={`/tarifs/nouveau?depuis=${grid.id}`} variant="secondary" size="sm">
            Créer une nouvelle version
          </LinkButton>
        }
      />

      {cree === "1" ? (
        <div className="mb-6">
          <FormMessage tone="success">Grille créée. Elle s&apos;applique aux calculs des dates qu&apos;elle couvre.</FormMessage>
        </div>
      ) : null}

      <div className="space-y-6">
        <TariffForm action={updateTariff.bind(null, grid.id)} initial={tariffFormValues(grid)} submitLabel="Enregistrer" />

        <Card>
          <CardHeader title="Supprimer la grille" />
          <CardBody className="space-y-3 text-sm text-slate-700">
            <p>
              Supprimez une grille saisie par erreur. Pour un changement de tarif, préférez une nouvelle version datée&nbsp;:
              les chiffres d&apos;affaires déjà calculés ne sont pas modifiés, mais l&apos;historique des tarifs serait
              perdu.
            </p>
            <ConfirmAction
              action={deleteTariff.bind(null, grid.id)}
              label="Supprimer la grille"
              confirmLabel="Oui, supprimer la grille"
              keepLabel="Garder la grille"
              question={<p>La grille sera supprimée définitivement. Cette action est irréversible.</p>}
            />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
