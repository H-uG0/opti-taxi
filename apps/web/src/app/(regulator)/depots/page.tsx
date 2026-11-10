import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { TBody, THead, Table, Td, Th } from "@/components/ui/table";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Dépôts" };

export default async function DepotsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("REGULATOR");
  const { inactifs } = await searchParams;
  const showInactive = inactifs === "1";

  const [depots, inactiveCount] = await Promise.all([
    db.depot.findMany({
      where: showInactive ? {} : { active: true },
      orderBy: [{ active: "desc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        address: true,
        active: true,
        _count: { select: { vehicles: { where: { active: true } }, drivers: { where: { active: true } } } },
      },
    }),
    db.depot.count({ where: { active: false } }),
  ]);
  const activeCount = depots.filter((d) => d.active).length;

  return (
    <>
      <PageHeader
        title="Dépôts"
        description={
          activeCount > 0
            ? `${activeCount} dépôt${activeCount > 1 ? "s" : ""} actif${activeCount > 1 ? "s" : ""} — départ et retour des tournées, rattachement du personnel.`
            : "Lieux de départ et de retour des tournées, et de rattachement du personnel."
        }
        actions={
          <>
            {inactiveCount > 0 ? (
              <LinkButton href={showInactive ? "/depots" : "/depots?inactifs=1"} variant="ghost" size="sm">
                {showInactive ? "Masquer les désactivés" : `Afficher les désactivés (${inactiveCount})`}
              </LinkButton>
            ) : null}
            <LinkButton href="/depots/nouveau" variant="primary">
              <Plus aria-hidden className="size-4" />
              Nouveau dépôt
            </LinkButton>
          </>
        }
      />

      {depots.length === 0 ? (
        <EmptyState
          title="Aucun dépôt"
          action={
            <LinkButton href="/depots/nouveau" variant="primary">
              Nouveau dépôt
            </LinkButton>
          }
        >
          Ajoutez les dépôts de la société&nbsp;: chaque véhicule part de son dépôt et y revient.
        </EmptyState>
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Nom</Th>
              <Th>Adresse</Th>
              <Th className="text-right">Véhicules actifs</Th>
              <Th className="text-right">Chauffeurs actifs</Th>
              <Th>Statut</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {depots.map((depot) => (
              <tr key={depot.id} className={depot.active ? "hover:bg-slate-50" : "bg-slate-50/60 text-slate-500"}>
                <Td className="font-medium">
                  <Link href={`/depots/${depot.id}`} className="text-slate-900 underline-offset-2 hover:text-brand-700 hover:underline">
                    {depot.name}
                  </Link>
                </Td>
                <Td className="max-w-80">
                  <span className="block truncate" title={depot.address}>
                    {depot.address}
                  </span>
                </Td>
                <Td className="tabular text-right">{depot._count.vehicles}</Td>
                <Td className="tabular text-right">{depot._count.drivers}</Td>
                <Td>{depot.active ? <Badge tone="success">Actif</Badge> : <Badge>Désactivé</Badge>}</Td>
                <Td className="text-right">
                  <LinkButton href={`/depots/${depot.id}`} size="sm" variant="ghost" aria-label={`Modifier ${depot.name}`}>
                    Modifier
                  </LinkButton>
                </Td>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
    </>
  );
}
