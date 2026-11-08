import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, VehicleTypeBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/layout";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { addDays, formatShortDate, fromIsoDate, todayIso, toIsoDate, tomorrowIso } from "@/lib/time";
import { formatEuros } from "@/lib/labels";
import { unavailabilityText } from "@/lib/fleet/availability";
import { consumptionStats, energyUnit } from "@/lib/fleet/consumption";
import { deadlineName, deadlineState, type DeadlineStatus } from "@/lib/fleet/maintenance";
import type { BadgeTone } from "@/components/ui/badge";
import {
  addDeadline,
  addFuelLog,
  addUnavailability,
  completeDeadline,
  deleteDeadline,
  deleteFuelLog,
  deleteUnavailability,
} from "../fleet-actions";
import { DeadlineForm, FuelForm, UnavailabilityForm } from "./fleet-cards";
import { setVehicleActive, updateVehicle } from "../actions";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { loadDepotOptions } from "@/app/(regulator)/depots/options";
import { loadDriverOptions } from "../_lib/driver-options";
import { BackLink, UpcomingRoutesCallout } from "../_lib/ui";
import { toUpcomingRoutes, upcomingRoutesNotice } from "../_lib/upcoming-routes";
import { vehicleFormValues } from "../schema";
import { VehicleForm } from "../vehicle-form";

export const metadata: Metadata = { title: "Modifier un véhicule" };

const STATUS_ORDER: Record<DeadlineStatus, number> = { overdue: 0, soon: 1, ok: 2, done: 3 };
const STATUS_TONES: Record<DeadlineStatus, BadgeTone> = { overdue: "danger", soon: "warning", ok: "neutral", done: "success" };
const STATUS_LABELS: Record<DeadlineStatus, string> = { overdue: "Dépassée", soon: "Bientôt", ok: "À venir", done: "Faite" };

export default async function EditVehiclePage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser("REGULATOR");
  const { id } = await params;
  const vehicle = await db.vehicle.findUnique({ where: { id } });
  if (!vehicle) notFound();

  const today = fromIsoDate(todayIso());
  const [drivers, depots, upcomingLocked, routesCount, upcomingRows] = await Promise.all([
    loadDriverOptions([vehicle.defaultDriverId, vehicle.defaultCrewMateId], vehicle.id),
    loadDepotOptions(vehicle.depotId),
    db.trip.count({ where: { lockedVehicleId: vehicle.id, serviceDate: { gte: today } } }),
    db.route.count({ where: { vehicleId: vehicle.id } }),
    db.route.findMany({
      where: { vehicleId: vehicle.id, serviceDate: { gte: today } },
      select: { serviceDate: true, status: true },
    }),
  ]);
  const todayText = todayIso();
  const [outages, deadlines, fuel] = await Promise.all([
    db.vehicleUnavailability.findMany({
      where: { vehicleId: vehicle.id, endDate: { gte: fromIsoDate(addDays(todayText, -30)) } },
      orderBy: { startDate: "asc" },
      select: { id: true, kind: true, startDate: true, endDate: true, note: true },
    }),
    db.maintenanceDeadline.findMany({
      where: { vehicleId: vehicle.id, OR: [{ doneDate: null }, { doneDate: { gte: fromIsoDate(addDays(todayText, -365)) } }] },
      orderBy: [{ dueDate: "asc" }, { dueKm: "asc" }],
    }),
    db.fuelLog.findMany({ where: { vehicleId: vehicle.id }, orderBy: [{ date: "desc" }, { odometerKm: "desc" }] }),
  ]);
  const stats = consumptionStats(fuel.map((f) => ({ ...f, date: toIsoDate(f.date) })));
  const unit = energyUnit(vehicle.energy);
  const deadlineRows = deadlines
    .map((d) => {
      const due = { ...d, dueDate: d.dueDate ? toIsoDate(d.dueDate) : null, doneDate: d.doneDate ? toIsoDate(d.doneDate) : null };
      return { ...due, state: deadlineState(due, todayText, stats.odometerKm) };
    })
    .sort((a, b) => STATUS_ORDER[a.state.status] - STATUS_ORDER[b.state.status]);
  const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
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
          depots={depots}
          submitLabel="Enregistrer"
        />

        <div className="grid items-start gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Indisponibilités" />
            <CardBody className="space-y-4 text-sm text-slate-700">
              <p className="text-xs text-slate-500">
                Entretien, réparation, contrôle, garde : le véhicule n&apos;est pas planifié ces jours-là et son équipage
                attitré est proposé ailleurs (page Équipages).
              </p>
              {outages.length === 0 ? (
                <p className="text-slate-500">Aucune indisponibilité récente ou à venir.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {outages.map((o) => {
                    const text = unavailabilityText({ kind: o.kind, startDate: toIsoDate(o.startDate), endDate: toIsoDate(o.endDate) });
                    const past = toIsoDate(o.endDate) < todayText;
                    return (
                      <li key={o.id} className="space-y-1 py-2">
                        <p className={past ? "text-slate-500" : "font-medium text-slate-900"}>
                          {text}
                          {past ? " (passée)" : ""}
                        </p>
                        {o.note ? <p className="text-xs text-slate-500">{o.note}</p> : null}
                        <ConfirmAction
                          action={deleteUnavailability.bind(null, vehicle.id, o.id)}
                          label="Supprimer"
                          confirmLabel="Confirmer la suppression"
                          pendingLabel="Suppression…"
                          variant="ghost"
                          question={<p>Supprimer « {text} » ? Le véhicule redevient planifiable ces jours-là.</p>}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="border-t border-slate-200 pt-4">
                <UnavailabilityForm action={addUnavailability.bind(null, vehicle.id)} defaultDate={tomorrowIso()} />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Entretien et échéances" />
            <CardBody className="space-y-4 text-sm text-slate-700">
              {deadlineRows.length === 0 ? (
                <p className="text-slate-500">Aucune échéance enregistrée : ajoutez le prochain contrôle technique, la révision…</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {deadlineRows.map((d) => (
                    <li key={d.id} className="space-y-1 py-2">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-900">{deadlineName(d)}</span>
                        <Badge tone={STATUS_TONES[d.state.status]}>{STATUS_LABELS[d.state.status]}</Badge>
                      </p>
                      <p className="text-xs text-slate-600">{d.state.text}</p>
                      {d.note ? <p className="text-xs text-slate-500">{d.note}</p> : null}
                      <div className="flex flex-wrap gap-2">
                        {d.state.status === "done" ? null : (
                          <ConfirmAction
                            action={completeDeadline.bind(null, vehicle.id, d.id)}
                            label="Marquer comme faite"
                            confirmLabel="Confirmer"
                            pendingLabel="Enregistrement…"
                            variant="secondary"
                            question={
                              <p>
                                « {deadlineName(d)} » faite aujourd&apos;hui
                                {stats.odometerKm !== null ? `, à ${nf.format(stats.odometerKm)} km (dernier relevé)` : ""} ?
                              </p>
                            }
                          />
                        )}
                        <ConfirmAction
                          action={deleteDeadline.bind(null, vehicle.id, d.id)}
                          label="Supprimer"
                          confirmLabel="Confirmer la suppression"
                          pendingLabel="Suppression…"
                          variant="ghost"
                          question={<p>Supprimer l&apos;échéance « {deadlineName(d)} » ?</p>}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t border-slate-200 pt-4">
                <DeadlineForm action={addDeadline.bind(null, vehicle.id)} />
              </div>
            </CardBody>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader title={`Consommation (${unit === "kWh" ? "recharges" : "pleins"})`} />
            <CardBody className="space-y-4 text-sm text-slate-700">
              <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-slate-500">Dernier relevé du compteur</dt>
                  <dd className="tabular font-medium">
                    {stats.odometerKm !== null && stats.odometerDate
                      ? `${nf.format(stats.odometerKm)} km (${formatShortDate(stats.odometerDate)})`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Consommation mesurée</dt>
                  <dd className="tabular font-medium">
                    {stats.per100Km !== null
                      ? `${nf.format(stats.per100Km)} ${unit}/100 km sur ${nf.format(stats.measuredKm)} km`
                      : "Il faut deux pleins complets"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Coût de l&apos;énergie</dt>
                  <dd className="tabular font-medium">
                    {stats.costPerKm !== null ? `${formatEuros(stats.costPerKm)}/km` : "—"}
                    <span className="block text-xs font-normal text-slate-500">
                      Coût au km utilisé par l&apos;optimiseur : {formatEuros(vehicle.costPerKm)}/km (énergie, entretien, usure).
                    </span>
                  </dd>
                </div>
              </dl>
              {fuel.length > 0 ? (
                <ul className="divide-y divide-slate-100">
                  {fuel.slice(0, 8).map((f) => (
                    <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                      <span className="tabular">
                        {formatShortDate(toIsoDate(f.date))} · {nf.format(f.odometerKm)} km · {nf.format(f.quantity)} {unit} ·{" "}
                        {formatEuros(f.cost)}
                        {f.fullTank ? "" : " · partiel"}
                      </span>
                      <ConfirmAction
                        action={deleteFuelLog.bind(null, vehicle.id, f.id)}
                        label="Supprimer"
                        confirmLabel="Confirmer"
                        pendingLabel="Suppression…"
                        variant="ghost"
                        question={<p>Supprimer ce relevé ?</p>}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="border-t border-slate-200 pt-4">
                <FuelForm action={addFuelLog.bind(null, vehicle.id)} defaultDate={todayText} unit={unit} />
              </div>
            </CardBody>
          </Card>
        </div>

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
