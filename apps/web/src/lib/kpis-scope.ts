/**
 * The dashboard narrowed to a depot or a vehicle type (KPI-02, ?depot= and
 * &type= in the address). Pure.
 *
 * The routes are those of the vehicles of the depot (or of the type), the
 * trips those placed on them, the fleet of each day its vehicles, the frozen
 * plan the lines of its vehicles. A trip left without a vehicle, cancelled or
 * handed over belongs to no depot: the demand of a depot is unknown, its
 * service rate « — » (the « Demande » tab says so). The optimizations and the
 * planning time stay those of the whole company (one planning a day).
 */
import type { VehicleType } from "@prisma/client";
import { partialPlanFigures } from "./kpis-plan";
import type { KpiData, KpiFleetDay } from "./kpis-rows";

export type KpiScope = { depotId: string | null; vehicleType: VehicleType | null };

export const NO_SCOPE: KpiScope = { depotId: null, vehicleType: null };

/** Depot and type of a vehicle (today's record: the fleet's history is not kept). */
export type VehicleMeta = { depotId: string; type: VehicleType };

export function isScoped(scope: KpiScope): boolean {
  return scope.depotId !== null || scope.vehicleType !== null;
}

/** Whether a vehicle of depot `depotId` and type `type` is in the scope (unknown values never are, once narrowed). */
export function inScope(scope: KpiScope, depotId: string | null | undefined, type: VehicleType | null | undefined): boolean {
  if (scope.depotId !== null && depotId !== scope.depotId) return false;
  if (scope.vehicleType !== null && type !== scope.vehicleType) return false;
  return true;
}

/** The rows of the scope; the same rows when nothing narrows them. */
export function scopeKpiData(data: KpiData, scope: KpiScope, vehicles: ReadonlyMap<string, VehicleMeta>): KpiData {
  if (!isScoped(scope)) return data;
  const meta = (vehicleId: string) => vehicles.get(vehicleId);
  const keepVehicle = (vehicleId: string) => inScope(scope, meta(vehicleId)?.depotId, meta(vehicleId)?.type);
  const routes = data.routes.filter((route) =>
    inScope(scope, route.depotId ?? meta(route.vehicleId)?.depotId, route.vehicleType ?? meta(route.vehicleId)?.type),
  );
  const routeIds = new Set(routes.flatMap((route) => (route.id ? [route.id] : [])));
  const fleet = data.fleet?.map(
    (day): KpiFleetDay => ({
      serviceDate: day.serviceDate,
      active: day.active.filter(keepVehicle),
      unavailable: day.unavailable.filter(keepVehicle),
      crewless: day.crewless.filter(keepVehicle),
    }),
  );
  return {
    ...data,
    routes,
    trips: data.trips.filter((trip) => trip.routeId !== null && routeIds.has(trip.routeId)),
    ...(fleet ? { fleet } : {}),
    ...(data.plans
      ? {
          plans: data.plans.map((plan) => ({
            ...plan,
            figures: partialPlanFigures(plan.figures, (line) => inScope(scope, line.depotId, line.vehicleType)),
          })),
        }
      : {}),
    scoped: true,
  };
}
