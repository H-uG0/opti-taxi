import "server-only";
import { db } from "@/lib/db";
import type { DriverOption } from "../vehicle-form";

/**
 * Drivers offered in the vehicle form: the active ones, plus those already
 * assigned to the vehicle being edited even if they were deactivated since.
 * Each option lists the other active vehicles the person is already in the
 * default crew of (`vehicleId` = the vehicle being edited, left out).
 */
export async function loadDriverOptions(keepIds: (string | null)[] = [], vehicleId?: string): Promise<DriverOption[]> {
  const ids = keepIds.filter((id): id is string => id !== null);
  const otherActive = { active: true, id: vehicleId ? { not: vehicleId } : undefined };
  const drivers = await db.driver.findMany({
    where: ids.length > 0 ? { OR: [{ active: true }, { id: { in: ids } }] } : { active: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      qualifications: true,
      active: true,
      defaultForVehicles: { where: otherActive, select: { id: true, label: true }, orderBy: { label: "asc" } },
      // As in the optimisation request, the crew mate only counts on an ambulance.
      crewMateForVehicles: {
        where: { ...otherActive, type: "AMBULANCE" },
        select: { id: true, label: true },
        orderBy: { label: "asc" },
      },
    },
  });
  return drivers.map((d) => ({
    id: d.id,
    name: `${d.lastName.toUpperCase()} ${d.firstName}`,
    qualifications: d.qualifications,
    active: d.active,
    seats: [
      ...d.defaultForVehicles.map((v) => ({ vehicleId: v.id, label: v.label, role: "driver" as const })),
      ...d.crewMateForVehicles.map((v) => ({ vehicleId: v.id, label: v.label, role: "crewMate" as const })),
    ],
  }));
}
