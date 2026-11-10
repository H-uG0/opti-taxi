"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { requireUser, type SessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  errorState,
  isUniqueViolation,
  messageState,
  readForm,
  successState,
  valueOf,
  type FieldErrors,
  type FormState,
  type FormValues,
} from "@/lib/forms";
import { loadDayCrewContext, type DayCrewContext } from "@/lib/optimizer/build-request";
import { lockPlanningDay } from "@/lib/planning/day-lock";
import { PLANNING_TX_OPTIONS, replanBlocker } from "@/lib/planning/run-optimization";
import { resolveDayCrews } from "@/lib/staff/day-crews";
import { fromIsoDate, isIsoDate } from "@/lib/time";
import {
  asShown,
  brokenFixedCrews,
  changedMeanwhileText,
  changedRows,
  concurrentChangeErrors,
  crewFormErrors,
  driverField,
  fixIntentVehicle,
  mergeFixedCrews,
  readCrewForm,
  shownVersions,
  takenFromFixedErrors,
  unavailableChoiceErrors,
  unfixIntentVehicle,
  versionField,
  type CrewFormRow,
} from "./schema";

function refreshPages() {
  revalidatePath("/equipages");
  revalidatePath("/planning");
}

const REPLAN_NOTICE = " Des tournées sont déjà calculées pour ce jour\u00a0: relancez l'optimisation depuis le planning pour les appliquer.";
const CONCURRENT_MESSAGE = "Équipages non enregistrés\u00a0: un collègue a modifié ces véhicules entre-temps.";

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
 * - "fix:<vehicleId>": that row's proposal, as shown, becomes a fixed crew;
 * - "unfix:<vehicleId>": that row goes back to the automatic proposal;
 * - "reset": the fixed crews the page showed go back to the proposals.
 * The checks run again under the planning lock of the date, on the fixed
 * crews as they are then, so two regulators cannot fix one person on two
 * vehicles at once. Refused once the day is validated, started or past, like
 * a re-optimisation: its routes keep their crews (the planning's « Changer
 * l'équipage » does).
 */
export async function saveDayCrews(_state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const values = readForm(formData);
  const date = valueOf(values, "date");
  if (!isIsoDate(date)) return messageState("Date invalide\u00a0: rechargez la page.");
  const blocker = await replanBlocker(date);
  if (blocker) return messageState(`Équipages non modifiables\u00a0: ${blocker}`, values);
  const routes = await db.route.count({ where: { serviceDate: fromIsoDate(date) } });
  const intent = valueOf(values, "intent");

  if (intent === "reset") return resetDayCrews(user, date, values, routes > 0);
  const unfixed = unfixIntentVehicle(intent);
  if (unfixed) return unfixDayCrew(user, date, unfixed, valueOf(values, versionField(unfixed)), routes > 0);
  const fixed = fixIntentVehicle(intent);
  if (intent !== "save" && !fixed) return messageState("Demande invalide\u00a0: rechargez la page.");

  const context = await loadDayCrewContext(db, date);
  const vehicles = context.input.vehicles.filter((v) => v.active);
  const { rows, errors: formErrors } = readCrewForm(values, vehicles);
  if (Object.keys(formErrors).length > 0) return errorState(formErrors, values);
  let changed: CrewFormRow[];
  if (fixed) {
    const row = rows.find((r) => r.vehicleId === fixed);
    if (!row) return messageState("Véhicule introuvable\u00a0: rechargez la page.");
    changed = [asShown(row)];
  } else {
    changed = changedRows(rows);
    if (changed.length === 0) return successState("Aucun équipage modifié\u00a0: les propositions et les équipages fixés restent tels quels.");
  }
  for (const crew of changed) {
    for (const id of [crew.driverId, crew.crewMateId]) {
      if (id !== null && !context.people.has(id)) return messageState("Une personne choisie n'existe plus\u00a0: rechargez la page.", values);
    }
  }

  const serviceDate = fromIsoDate(date);
  let written: CrewFormRow[];
  try {
    written = await db.$transaction(async (tx) => {
      // The same checks on the fixed crews as they are once no colleague can write them any more.
      await lockPlanningDay(tx, date);
      const now = await loadDayCrewContext(tx, date);
      const refused = refusal(now, changed, date, values);
      if (refused) throw new CrewChangeRefused(refused);

      // An unavailable vehicle keeps no crew: once back in service, it gets the usual proposal.
      const outOfService = new Set(now.plan.crews.filter((c) => c.unavailable).map((c) => c.vehicleId));
      const kept = changed.filter((row) => !outOfService.has(row.vehicleId));
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
          const current = now.savedMeta.get(row.vehicleId);
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
      return kept;
    }, PLANNING_TX_OPTIONS);
  } catch (error) {
    if (error instanceof CrewChangeRefused) return error.state;
    if (!(error instanceof ConcurrentCrewChange)) throw error;
    const now = await db.dayCrew.findUnique({
      where: { serviceDate_vehicleId: { serviceDate, vehicleId: error.vehicleId } },
      select: { updatedAt: true, updatedBy: { select: { name: true } } },
    });
    const message = changedMeanwhileText(now ? { updatedAt: now.updatedAt, updatedBy: now.updatedBy?.name ?? null } : undefined);
    return errorState({ [driverField(error.vehicleId)]: message }, values, CONCURRENT_MESSAGE);
  }
  refreshPages();
  const replan = routes > 0 ? REPLAN_NOTICE : "";
  if (fixed) return successState(`Proposition fixée pour ce véhicule\u00a0: elle ne suit plus les absences.${replan}`);
  const count = written.length;
  return successState(
    `${count > 1 ? `${count} équipages fixés` : "Équipage fixé"} pour ce jour\u202f; les autres véhicules gardent la proposition automatique.${replan}`,
  );
}

/** The checks found a problem inside the transaction: nothing is written. */
class CrewChangeRefused extends Error {
  constructor(readonly state: FormState) {
    super("day crew change refused");
  }
}

/**
 * Why the changed rows cannot be written on the fixed crews of `context`, or
 * null: a row a colleague changed since the page was shown, a person taken
 * from a fixed crew the regulator did not change, the same rules as the
 * screen and the optimizer on the crews once the change is applied, a person
 * chosen while absent or deactivated (fixed, they would be replaced at once).
 */
function refusal(context: DayCrewContext, changed: readonly CrewFormRow[], date: string, values: FormValues): FormState | null {
  const concurrent = concurrentChangeErrors(changed, context.savedMeta);
  if (Object.keys(concurrent).length > 0) return errorState(concurrent, values, CONCURRENT_MESSAGE);

  const ids = new Set(changed.map((row) => row.vehicleId));
  const labels = new Map(context.input.vehicles.map((v) => [v.id, v.label]));
  const after = resolveDayCrews({ ...context.input, saved: mergeFixedCrews(context.input.saved, changed) });
  const errors: FieldErrors = {
    ...crewFormErrors(after, ids),
    ...unavailableChoiceErrors(changed, context.people, context.input.absences, date),
    // Last: the clearest message, the same whatever the display order.
    ...takenFromFixedErrors(changed, context.plan, context.people, labels),
  };
  if (Object.keys(errors).length > 0) return errorState(errors, values, "Équipages non enregistrés\u00a0: corrigez les postes signalés.");
  // Any other problem the change would cause on a fixed crew left as it is.
  const broken = brokenFixedCrews(context.plan, after, ids);
  if (broken.length > 0) {
    const list = broken.map((b) => `${labels.get(b.vehicleId) ?? "?"}\u00a0: ${b.message}`).join("\u202f; ");
    return messageState(`Équipages non enregistrés\u00a0: ce changement bloquerait un équipage fixé que vous n'avez pas modifié (${list}).`, values);
  }
  return null;
}

/**
 * « Revenir aux propositions (tout le jour) »: the fixed crews the page
 * showed, at the version it showed, go back to the proposals. A crew a
 * colleague fixed or changed since is kept, and named.
 */
async function resetDayCrews(user: SessionUser, date: string, values: FormValues, hasRoutes: boolean): Promise<FormState> {
  const serviceDate = fromIsoDate(date);
  const vehicleIds = (await db.vehicle.findMany({ select: { id: true } })).map((v) => v.id);
  const shown = shownVersions(values, vehicleIds);
  const { removed, kept } = await db.$transaction(async (tx) => {
    await lockPlanningDay(tx, date);
    const { count } =
      shown.length > 0
        ? await tx.dayCrew.deleteMany({ where: { serviceDate, OR: shown.map((s) => ({ vehicleId: s.vehicleId, updatedAt: s.updatedAt })) } })
        : { count: 0 };
    if (count > 0) {
      await audit(tx, user, { action: "day_crew.reset", entity: "DayCrew", serviceDate: date, details: { crews: count } });
    }
    const left = await tx.dayCrew.findMany({
      where: { serviceDate },
      select: { vehicleId: true, updatedAt: true, updatedBy: { select: { name: true } } },
    });
    return { removed: count, kept: left };
  }, PLANNING_TX_OPTIONS);
  refreshPages();
  if (kept.length > 0) {
    const errors = Object.fromEntries(
      kept.map((row) => [driverField(row.vehicleId), changedMeanwhileText({ updatedAt: row.updatedAt, updatedBy: row.updatedBy?.name ?? null })]),
    );
    const done = removed > 0 ? `${removed > 1 ? `${removed} équipages remis` : "1 équipage remis"} aux propositions automatiques\u202f; ` : "";
    return errorState(
      errors,
      null,
      kept.length > 1
        ? `${done}${kept.length} équipages fixés gardés\u00a0: un collègue les a fixés ou modifiés depuis l'affichage de la page.`
        : `${done}1 équipage fixé gardé\u00a0: un collègue l'a fixé ou modifié depuis l'affichage de la page.`,
    );
  }
  if (removed === 0) return successState("Les équipages de ce jour étaient déjà ceux proposés automatiquement.");
  return successState(`Équipages remis aux propositions automatiques.${hasRoutes ? REPLAN_NOTICE : ""}`);
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
  if (version === "" || Number.isNaN(shown.getTime())) return messageState("Page périmée\u00a0: rechargez la page.");
  const removed = await db.$transaction(async (tx) => {
    await lockPlanningDay(tx, date);
    const row = await tx.dayCrew.findUnique({ where: { serviceDate_vehicleId: { serviceDate, vehicleId } }, select: { id: true } });
    if (!row) return 0;
    const { count } = await tx.dayCrew.deleteMany({ where: { id: row.id, updatedAt: shown } });
    if (count > 0) {
      await audit(tx, user, { action: "day_crew.unfix", entity: "DayCrew", entityId: row.id, serviceDate: date, details: { vehicleId } });
    }
    return count;
  }, PLANNING_TX_OPTIONS);
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
