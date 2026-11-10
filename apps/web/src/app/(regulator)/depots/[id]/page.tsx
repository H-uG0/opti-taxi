import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, VehicleTypeBadge } from "@/components/ui/badge";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { FormMessage } from "@/components/ui/form";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/layout";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { compareVehicles } from "@/lib/fleet/order";
import { setDepotActive, updateDepot } from "../actions";
import { geocoderEnabled } from "@/lib/geocode";
import { DepotForm } from "../depot-form";
import { depotFormValues } from "../schema";
import { BackLink } from "@/components/ui/back-link";
import { formatPersonName } from "@/lib/names";

/** The tab names the record (never a patient: titles stay in the browser history). */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const record = await db.depot.findUnique({ where: { id }, select: { name: true } });
  return { title: record?.name ?? "Dépôt" };
}

export default async function EditDepotPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cree?: string }>;
}) {
  const { cree } = await searchParams;
  await requireUser("REGULATOR");
  const { id } = await params;
  const depot = await db.depot.findUnique({
    where: { id },
    include: {
      vehicles: { orderBy: [{ active: "desc" }, { label: "asc" }], select: { id: true, label: true, type: true, active: true } },
      drivers: {
        orderBy: [{ active: "desc" }, { lastName: "asc" }, { firstName: "asc" }],
        select: { id: true, firstName: true, lastName: true, active: true },
      },
    },
  });
  if (!depot) notFound();
  const activeVehicles = depot.vehicles.filter((v) => v.active).length;

  return (
    <div className="max-w-5xl">
      <BackLink href="/depots">Dépôts</BackLink>
      <PageHeader
        title={depot.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>{depot.address}</span>
            {depot.active ? <Badge tone="success">Actif</Badge> : <Badge>Désactivé</Badge>}
          </span>
        }
      />

      {cree === "1" ? (
        <div className="mb-6">
          <FormMessage tone="success">Dépôt créé. Rattachez-lui maintenant ses véhicules et son personnel depuis leurs fiches.</FormMessage>
        </div>
      ) : null}

      <div className="space-y-6">
        <DepotForm action={updateDepot.bind(null, depot.id)} initial={depotFormValues(depot)} submitLabel="Enregistrer" geocoderEnabled={geocoderEnabled()} />

        <Card>
          <CardHeader title="Rattachés à ce dépôt" />
          <CardBody className="grid gap-6 text-sm text-slate-700 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 font-medium text-slate-900">Véhicules ({depot.vehicles.length})</h3>
              {depot.vehicles.length === 0 ? (
                <p className="text-slate-500">Aucun véhicule : choisissez ce dépôt dans la fiche d&apos;un véhicule.</p>
              ) : (
                <ul className="space-y-1">
                  {/* Active first, then the order of every list: type, then number (« Taxi 2 » before « Taxi 10 »). */}
                  {[...depot.vehicles].sort((a, b) => Number(b.active) - Number(a.active) || compareVehicles(a, b)).map((v) => (
                    <li key={v.id} className="flex items-center gap-2">
                      <VehicleTypeBadge type={v.type} />
                      <Link href={`/vehicules/${v.id}`} className="underline-offset-2 hover:text-brand-700 hover:underline">
                        {v.label}
                      </Link>
                      {v.active ? null : <Badge>Désactivé</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-2 font-medium text-slate-900">Personnel ({depot.drivers.length})</h3>
              {depot.drivers.length === 0 ? (
                <p className="text-slate-500">Personne : choisissez ce dépôt dans la fiche d&apos;un chauffeur.</p>
              ) : (
                <ul className="space-y-1">
                  {depot.drivers.map((d) => (
                    <li key={d.id} className="flex items-center gap-2">
                      <Link href={`/chauffeurs/${d.id}`} className="underline-offset-2 hover:text-brand-700 hover:underline">
                        {formatPersonName(d)}
                      </Link>
                      {d.active ? null : <Badge>Désactivé</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Statut" />
          <CardBody className="space-y-3 text-sm text-slate-700">
            {depot.active ? (
              <>
                <p>
                  Le dépôt est <strong>actif</strong> : il est proposé dans les fiches véhicule et chauffeur.
                  {activeVehicles > 0
                    ? ` Pour le désactiver, rattachez d'abord ses ${activeVehicles} véhicule${activeVehicles > 1 ? "s" : ""} actif${activeVehicles > 1 ? "s" : ""} à un autre dépôt.`
                    : ""}
                </p>
                <ConfirmAction
                  action={setDepotActive.bind(null, depot.id, false)}
                  label="Désactiver le dépôt"
                  confirmLabel="Oui, désactiver le dépôt"
                  keepLabel="Garder le dépôt actif"
                  question={
                    <p>
                      Le dépôt ne sera plus proposé dans les fiches véhicule et chauffeur. Le personnel qui y est rattaché
                      le reste.
                    </p>
                  }
                />
              </>
            ) : (
              <>
                <p>
                  Le dépôt est <strong>désactivé</strong> : il n&apos;est plus proposé dans les fiches véhicule et
                  chauffeur.
                </p>
                <ConfirmAction
                  action={setDepotActive.bind(null, depot.id, true)}
                  label="Réactiver le dépôt"
                  confirmLabel="Oui, réactiver le dépôt"
                  tone="primary"
                  question={<p>Le dépôt sera de nouveau proposé dans les fiches véhicule et chauffeur.</p>}
                />
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
