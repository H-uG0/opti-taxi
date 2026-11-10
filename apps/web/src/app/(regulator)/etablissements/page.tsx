import type { Metadata } from "next";
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { Plus } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { FACILITY_TYPE_LABELS } from "@/lib/labels";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { FilterBar, FilterSearch, FilterSelect } from "@/components/ui/filter-bar";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { Table, TBody, Td, Th, THead } from "@/components/ui/table";
import { FACILITY_TYPES } from "./_lib/options";

export const metadata: Metadata = { title: "Établissements" };

const STATUS_FILTERS = {
  actifs: "Actifs",
  inactifs: "Désactivés",
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
            : `${facilities.length} établissement${plural} de soins${status === "inactifs" ? ` désactivé${plural}` : ""}`
        }
        actions={
          <LinkButton href="/etablissements/nouveau" variant="primary">
            <Plus aria-hidden className="size-4" />
            Nouvel établissement
          </LinkButton>
        }
      />

      <FilterBar action="/etablissements" label="Filtrer les établissements" resetHref="/etablissements" filtered={filtered} className="mb-4">
        <FilterSearch defaultValue={q} placeholder="Nom ou ville" />
        <FilterSelect
          name="type"
          label="Type"
          value={type ?? ""}
          allLabel="Tous les types"
          options={FACILITY_TYPES.map((t) => ({ value: t, label: FACILITY_TYPE_LABELS[t] }))}
          className="w-52"
        />
        <FilterSelect
          name="statut"
          label="Statut"
          value={status}
          defaultChoice="actifs"
          options={Object.entries(STATUS_FILTERS).map(([value, label]) => ({ value, label }))}
          className="w-36"
        />
      </FilterBar>

      {facilities.length === 0 ? (
        <EmptyState
          title={filtered ? "Aucun établissement ne correspond aux filtres" : "Aucun établissement enregistré"}
          action={
            filtered ? (
              <LinkButton href="/etablissements">Voir les établissements actifs</LinkButton>
            ) : (
              <LinkButton href="/etablissements/nouveau" variant="primary">
                Nouvel établissement
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
                  <Td className="tabular text-right">{count === 0 ? <span className="text-slate-500">0</span> : count}</Td>
                  <Td>
                    <Badge tone={f.active ? "success" : "neutral"}>{f.active ? "Actif" : "Désactivé"}</Badge>
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
