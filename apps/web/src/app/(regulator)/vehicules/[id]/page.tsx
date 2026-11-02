import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, VehicleTypeBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/layout";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { fromIsoDate, todayIso } from "@/lib/time";
import { setVehicleActive, updateVehicle } from "../actions";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { loadDriverOptions } from "../_lib/driver-options";
import { BackLink, UpcomingRoutesCallout } from "../_lib/ui";
import { toUpcomingRoutes, upcomingRoutesNotice } from "../_lib/upcoming-routes";
import { vehicleFormValues } from "../schema";
import { VehicleForm } from "../vehicle-form";

export const metadata: Metadata = { title: "Modifier un véhicule" };

export default async function EditVehiclePage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser("REGULATOR");
  const { id } = await params;
  const vehicle = await db.vehicle.findUnique({ where: { id } });
  if (!vehicle) notFound();

  const today = fromIsoDate(todayIso());
  const [drivers, upcomingLocked, routesCount, upcomingRows] = await Promise.all([
    loadDriverOptions([vehicle.defaultDriverId, vehicle.defaultCrewMateId], vehicle.id),
    db.trip.count({ where: { lockedVehicleId: vehicle.id, serviceDate: { gte: today } } }),
    db.route.count({ where: { vehicleId: vehicle.id } }),
    db.route.findMany({
      where: { vehicleId: vehicle.id, serviceDate: { gte: today } },
      select: { serviceDate: true, status: true },
    }),
  ]);
  const upcomingRoutes = toUpcomingRoutes(upcomingRows);
  const upcomingNotice = upcomingRoutesNotice(upcomingRoutes, "vehicle");

  return (
    <div className="max-w-5xl">
      <BackLink href="/vehicules">Véhicules</BackLink>
      <PageHeader
        title={vehicle.label}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <VehicleTypeBadge type={vehicle.type} />
            <span className="font-mono text-xs">{vehicle.registration}</span>
            {vehicle.active ? <Badge tone="success">Actif</Badge> : <Badge>Désactivé</Badge>}
          </span>
        }
      />

      <div className="space-y-6">
        <VehicleForm
          action={updateVehicle.bind(null, vehicle.id)}
          initial={vehicleFormValues(vehicle)}
          drivers={drivers}
          submitLabel="Enregistrer"
        />

        <Card>
          <CardHeader title="Statut" />
          <CardBody className="space-y-3 text-sm text-slate-700">
            {vehicle.active ? (
              <>
                <p>
                  Le véhicule est <strong>actif</strong> : il est proposé à l&apos;optimisation des tournées. Pour une
                  panne ou une sortie de flotte, désactivez-le plutôt que de le supprimer : son historique (
                  {routesCount} tournée{routesCount > 1 ? "s" : ""}) est conservé.
                </p>
                <ConfirmAction
                  action={setVehicleActive.bind(null, vehicle.id, false)}
                  label="Désactiver le véhicule"
                  confirmLabel="Confirmer la désactivation"
                  pendingLabel="Désactivation…"
                  question={
                    <div className="space-y-2">
                      <p>
                        Le véhicule ne sera plus proposé à l&apos;optimisation.
                        {upcomingLocked > 0
                          ? ` ${upcomingLocked} course${upcomingLocked > 1 ? "s" : ""} à venir figée${upcomingLocked > 1 ? "s" : ""} sur ce véhicule ser${upcomingLocked > 1 ? "ont" : "a"} libérée${upcomingLocked > 1 ? "s" : ""}.`
                          : ""}{" "}
                        Les tournées passées restent consultables.
                      </p>
                      {upcomingNotice ? <p className="font-medium text-amber-800">{upcomingNotice}</p> : null}
                    </div>
                  }
                />
              </>
            ) : (
              <>
                <p>
                  Le véhicule est <strong>désactivé</strong> : il n&apos;est plus proposé à l&apos;optimisation. Son
                  historique ({routesCount} tournée{routesCount > 1 ? "s" : ""}) est conservé.
                </p>
                <UpcomingRoutesCallout routes={upcomingRoutes} subject="vehicle" />
                <ConfirmAction
                  action={setVehicleActive.bind(null, vehicle.id, true)}
                  label="Réactiver le véhicule"
                  confirmLabel="Confirmer la réactivation"
                  pendingLabel="Réactivation…"
                  variant="primary"
                  question={<p>Le véhicule sera de nouveau proposé à l&apos;optimisation dès le prochain calcul.</p>}
                />
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
