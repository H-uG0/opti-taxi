import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { Plus, Search } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { FACILITY_TYPE_LABELS } from "@/lib/labels";
import { Badge } from "@/components/ui/badge";
import { Button, LinkButton } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { Table, TBody, Td, Th, THead } from "@/components/ui/table";
import { FACILITY_TYPES } from "./_lib/options";

export const metadata: Metadata = { title: "Établissements" };

const STATUS_FILTERS = {
  actifs: "Actifs",
  inactifs: "Inactifs",
  tous: "Tous",
} as const;
type StatusFilter = keyof typeof STATUS_FILTERS;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export default async function FacilitiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("REGULATOR");
  const params = await searchParams;
  const q = first(params.q).trim().slice(0, 100);
  const statusParam = first(params.statut);
  const status: StatusFilter = Object.hasOwn(STATUS_FILTERS, statusParam) ? (statusParam as StatusFilter) : "actifs";
  const typeParam = first(params.type);
  const type = FACILITY_TYPES.find((t) => t === typeParam) ?? null;

  const terms = q.split(/\s+/).filter(Boolean).slice(0, 5);
  const where: Prisma.FacilityWhereInput = {
    ...(status === "tous" ? {} : { active: status === "actifs" }),
    ...(type ? { type } : {}),
    AND: terms.map((term) => ({
      OR: [
        { name: { contains: term, mode: "insensitive" as const } },
        { city: { contains: term, mode: "insensitive" as const } },
      ],
    })),
  };

  const [facilities, regulars] = await Promise.all([
    db.facility.findMany({
      where,
      orderBy: [{ city: "asc" }, { name: "asc" }],
      select: { id: true, name: true, type: true, city: true, postalCode: true, phone: true, active: true },
    }),
    // Regular patients: active patients with an active recurrence to the facility.
    db.recurrence.findMany({
      where: { active: true, patient: { active: true } },
      select: { facilityId: true, patientId: true },
      distinct: ["facilityId", "patientId"],
    }),
  ]);

  const regularCount = new Map<string, number>();
  for (const r of regulars) regularCount.set(r.facilityId, (regularCount.get(r.facilityId) ?? 0) + 1);

  const filtered = q !== "" || status !== "actifs" || type !== null;
  const plural = facilities.length > 1 ? "s" : "";

  return (
    <div>
      <PageHeader
        title="Établissements"
        description={
          facilities.length === 0
            ? "Aucun établissement pour ces critères."
            : `${facilities.length} établissement${plural} de soins${status === "inactifs" ? ` inactif${plural}` : ""}`
        }
        actions={
          <LinkButton href="/etablissements/nouveau" variant="primary">
            <Plus aria-hidden className="size-4" />
            Nouvel établissement
          </LinkButton>
        }
      />

      <Form
        key={`${q}|${type ?? ""}|${status}`}
        action="/etablissements"
        role="search"
        className="mb-4 flex flex-wrap items-end gap-3"
      >
        <Field label="Rechercher" htmlFor="q" className="w-full sm:w-72">
          <Input id="q" name="q" type="search" defaultValue={q} placeholder="Nom ou ville" maxLength={100} />
        </Field>
        <Field label="Type" htmlFor="type" className="w-52">
          <Select id="type" name="type" defaultValue={type ?? ""}>
            <option value="">Tous les types</option>
            {FACILITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {FACILITY_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Statut" htmlFor="statut" className="w-36">
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
          Filtrer
        </Button>
        {filtered ? (
          <Link
            href="/etablissements"
            className="pb-2.5 text-sm text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline"
          >
            Réinitialiser
          </Link>
        ) : null}
      </Form>

      {facilities.length === 0 ? (
        <EmptyState
          title={filtered ? "Aucun établissement ne correspond aux filtres" : "Aucun établissement enregistré"}
          action={
            filtered ? (
              <LinkButton href="/etablissements">Voir les établissements actifs</LinkButton>
            ) : (
              <LinkButton href="/etablissements/nouveau" variant="primary">
                Créer le premier établissement
              </LinkButton>
            )
          }
        >
          {filtered
            ? "Modifiez la recherche ou les filtres."
            : "Centres de dialyse, hôpitaux, centres de radiothérapie… : les destinations des courses."}
        </EmptyState>
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Nom</Th>
              <Th>Type</Th>
              <Th>Ville</Th>
              <Th>Téléphone accueil</Th>
              <Th className="text-right">Patients réguliers</Th>
              <Th>Statut</Th>
            </tr>
          </THead>
          <TBody>
            {facilities.map((f) => {
              const count = regularCount.get(f.id) ?? 0;
              return (
                <tr key={f.id} className="hover:bg-slate-50">
                  <Td>
                    <Link
                      href={`/etablissements/${f.id}`}
                      className="font-medium text-slate-900 underline-offset-2 hover:text-brand-800 hover:underline"
                    >
                      {f.name}
                    </Link>
                  </Td>
                  <Td className="whitespace-nowrap">{FACILITY_TYPE_LABELS[f.type]}</Td>
                  <Td className="whitespace-nowrap">
                    {f.city}
                    <span className="tabular ml-1.5 text-xs text-slate-500">{f.postalCode}</span>
                  </Td>
                  <Td className="tabular whitespace-nowrap">
                    {f.phone ?? <span className="text-amber-700">Non renseigné</span>}
                  </Td>
                  <Td className="tabular text-right">{count === 0 ? <span className="text-slate-400">0</span> : count}</Td>
                  <Td>
                    <Badge tone={f.active ? "success" : "neutral"}>{f.active ? "Actif" : "Inactif"}</Badge>
                  </Td>
                </tr>
              );
            })}
          </TBody>
        </Table>
      )}
    </div>
  );
}
