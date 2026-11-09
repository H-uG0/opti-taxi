"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { requireUser, type SessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorState, isUniqueViolation, messageState, readForm, successState, valueOf, type FormState } from "@/lib/forms";
import { loadDayCrewContext } from "@/lib/optimizer/build-request";
import { replanBlocker } from "@/lib/planning/run-optimization";
import { resolveDayCrews } from "@/lib/staff/day-crews";
import { fromIsoDate, isIsoDate } from "@/lib/time";
import {
  changedMeanwhileText,
  changedRows,
  concurrentChangeErrors,
  crewFormErrors,
  driverField,
  mergeFixedCrews,
  readCrewForm,
  unavailableChoiceErrors,
  unfixIntentVehicle,
  versionField,
} from "./schema";

function refreshPages() {
  revalidatePath("/equipages");
  revalidatePath("/planning");
}

const REPLAN_NOTICE = " Des tournées sont déjà calculées pour ce jour : relancez l'optimisation depuis le planning pour les appliquer.";

/** A fixed crew changed by a colleague between the checks and the write: nothing is written. */
class ConcurrentCrewChange extends Error {
  constructor(readonly vehicleId: string) {
    super("concurrent day crew change");
  }
}

/**
 * Crews of a date (Équipages page), by intent:
 * - "save": the rows the regulator changed become fixed crews (DayCrew), the
 *   others stay proposals. A row changed by a colleague since the page was
 *   shown (DayCrew.updatedAt) is refused with who changed it;
 * - "unfix:<vehicleId>": that row goes back to the automatic proposal;
 * - "reset": every crew of the date goes back to the proposals.
 * Refused once the day is validated, started or past, like a re-optimisation:
 * its routes keep their crews (the planning's « Changer l'équipage » does).
 */
export async function saveDayCrews(_state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const values = readForm(formData);
  const date = valueOf(values, "date");
  if (!isIsoDate(date)) return messageState("Date invalide : rechargez la page.");
  const blocker = await replanBlocker(date);
  if (blocker) return messageState(`Équipages non modifiables : ${blocker}`, values);
  const serviceDate = fromIsoDate(date);
  const routes = await db.route.count({ where: { serviceDate } });
  const intent = valueOf(values, "intent");

  if (intent === "reset") {
    const count = await db.$transaction(async (tx) => {
      const removed = await tx.dayCrew.deleteMany({ where: { serviceDate } });
      if (removed.count > 0) {
        await audit(tx, user, {
          action: "day_crew.reset",
          entity: "DayCrew",
          serviceDate: date,
          details: { crews: removed.count },
        });
      }
      return removed.count;
    });
    refreshPages();
    if (count === 0) return successState("Les équipages de ce jour étaient déjà ceux proposés automatiquement.");
    return successState(`Équipages remis aux propositions automatiques.${routes > 0 ? REPLAN_NOTICE : ""}`);
  }

  const unfixed = unfixIntentVehicle(intent);
  if (unfixed) return unfixDayCrew(user, date, unfixed, valueOf(values, versionField(unfixed)), routes > 0);
  if (intent !== "save") return messageState("Demande invalide : rechargez la page.");

  const context = await loadDayCrewContext(db, date);
  const vehicles = context.input.vehicles.filter((v) => v.active);
  const { rows, errors: formErrors } = readCrewForm(values, vehicles);
  if (Object.keys(formErrors).length > 0) return errorState(formErrors, values);
  const changed = changedRows(rows);
  if (changed.length === 0) return successState("Aucun équipage modifié : les propositions et les équipages fixés restent tels quels.");
  for (const crew of changed) {
    for (const id of [crew.driverId, crew.crewMateId]) {
      if (id !== null && !context.people.has(id)) return messageState("Une personne choisie n'existe plus : rechargez la page.", values);
    }
  }
  const concurrent = concurrentChangeErrors(changed, context.savedMeta);
  if (Object.keys(concurrent).length > 0) {
    return errorState(concurrent, values, "Équipages non enregistrés : un collègue a modifié ces véhicules entre-temps.");
  }

  // The same rules as the screen and the optimizer, on the fixed crews once the changed rows are applied;
  // a person chosen while absent or deactivated is refused (fixed, they would be replaced at once).
  const plan = resolveDayCrews({ ...context.input, saved: mergeFixedCrews(context.input.saved, changed) });
  const errors = {
    ...crewFormErrors(plan, new Set(changed.map((row) => row.vehicleId))),
    ...unavailableChoiceErrors(changed, context.people, context.input.absences, date),
  };
  if (Object.keys(errors).length > 0) {
    return errorState(errors, values, "Équipages non enregistrés : corrigez les postes signalés.");
  }

  // An unavailable vehicle keeps no crew: once back in service, it gets the usual proposal.
  const outOfService = new Set(plan.crews.filter((c) => c.unavailable).map((c) => c.vehicleId));
  const kept = changed.filter((row) => !outOfService.has(row.vehicleId));
  try {
    await db.$transaction(async (tx) => {
      for (const row of kept) {
        const data = { driverId: row.driverId, crewMateId: row.crewMateId, updatedById: user.id, updatedAt: new Date() };
        let id: string;
        if (row.version === "") {
          // A colleague fixing the same vehicle meanwhile makes this create fail (unique serviceDate + vehicleId).
          try {
            id = (await tx.dayCrew.create({ data: { serviceDate, vehicleId: row.vehicleId, ...data }, select: { id: true } })).id;
          } catch (error) {
            if (isUniqueViolation(error, "vehicleId")) throw new ConcurrentCrewChange(row.vehicleId);
            throw error;
          }
        } else {
          // Written only over the version the row showed.
          const current = context.savedMeta.get(row.vehicleId);
          const { count } = await tx.dayCrew.updateMany({
            where: { serviceDate, vehicleId: row.vehicleId, updatedAt: new Date(row.version) },
            data,
          });
          if (count === 0 || !current) throw new ConcurrentCrewChange(row.vehicleId);
          id = current.id;
        }
        // Who decided which crew drives which patients that day (ids only).
        await audit(tx, user, {
          action: "day_crew.save",
          entity: "DayCrew",
          entityId: id,
          serviceDate: date,
          details: { vehicleId: row.vehicleId, driverId: row.driverId, crewMateId: row.crewMateId },
        });
      }
    });
  } catch (error) {
    if (!(error instanceof ConcurrentCrewChange)) throw error;
    const now = await db.dayCrew.findUnique({
      where: { serviceDate_vehicleId: { serviceDate, vehicleId: error.vehicleId } },
      select: { updatedAt: true, updatedBy: { select: { name: true } } },
    });
    const message = changedMeanwhileText(now ? { updatedAt: now.updatedAt, updatedBy: now.updatedBy?.name ?? null } : undefined);
    return errorState(
      { [driverField(error.vehicleId)]: message },
      values,
      "Équipages non enregistrés : un collègue a modifié ces véhicules entre-temps.",
    );
  }
  refreshPages();
  const count = kept.length;
  return successState(
    `${count > 1 ? `${count} équipages fixés` : "Équipage fixé"} pour ce jour ; les autres véhicules gardent la proposition automatique.${routes > 0 ? REPLAN_NOTICE : ""}`,
  );
}

/** « Revenir à la proposition » of one vehicle, only over the version the row showed. */
async function unfixDayCrew(
  user: SessionUser,
  date: string,
  vehicleId: string,
  version: string,
  hasRoutes: boolean,
): Promise<FormState> {
  const serviceDate = fromIsoDate(date);
  const shown = new Date(version);
  if (version === "" || Number.isNaN(shown.getTime())) return messageState("Page périmée : rechargez la page.");
  const removed = await db.$transaction(async (tx) => {
    const row = await tx.dayCrew.findUnique({ where: { serviceDate_vehicleId: { serviceDate, vehicleId } }, select: { id: true } });
    if (!row) return 0;
    const { count } = await tx.dayCrew.deleteMany({ where: { id: row.id, updatedAt: shown } });
    if (count > 0) {
      await audit(tx, user, { action: "day_crew.unfix", entity: "DayCrew", entityId: row.id, serviceDate: date, details: { vehicleId } });
    }
    return count;
  });
  refreshPages();
  if (removed === 0) {
    const now = await db.dayCrew.findUnique({
      where: { serviceDate_vehicleId: { serviceDate, vehicleId } },
      select: { updatedAt: true, updatedBy: { select: { name: true } } },
    });
    if (!now) return successState("Ce véhicule suivait déjà la proposition automatique.");
    return messageState(changedMeanwhileText({ updatedAt: now.updatedAt, updatedBy: now.updatedBy?.name ?? null }));
  }
  return successState(`Retour à la proposition automatique pour ce véhicule.${hasRoutes ? REPLAN_NOTICE : ""}`);
}
