"use server";

import { revalidatePath } from "next/cache";
import type { AppSettings, TrafficZone } from "@prisma/client";
import { audit, changedFields, type AuditDetails } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/domain/settings";
import { FACTOR_FIELDS, loadTrafficZones, TRAFFIC_BANDS } from "@/lib/domain/traffic";
import { loadObservedFactors } from "@/lib/domain/traffic-observed";
import { invalidState, isUniqueViolation, messageState, readForm, successState, type FormState } from "@/lib/forms";
import { settingsSavedMessage, settingsSchema } from "./schema";
import { targetChanges, targetsSchema, toTargetRows } from "./targets-schema";
import { toTrafficUpdate, trafficChanged, trafficSchema, type TrafficUpdate } from "./traffic-schema";

export async function saveSettings(_state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const values = readForm(formData);
  const parsed = settingsSchema.safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);

  // Creates the singleton row with its defaults if it does not exist yet.
  const previous = await getSettings(db);
  const changes = changedFields(previous, parsed.data);
  await db.$transaction(async (tx) => {
    await tx.appSettings.update({ where: { id: 1 }, data: parsed.data });
    // Old and new value, the regulation number included: every driver calls it from the roadmap.
    if (Object.keys(changes).length > 0) {
      await audit(tx, user, { action: "settings.update", entity: "AppSettings", entityId: "1", details: changes });
    }
  });
  revalidatePath("/parametres");
  // The crew settings change the proposals of the crews of the day.
  revalidatePath("/equipages");
  revalidatePath("/planning");
  // The regulation phone number is shown on the drivers' roadmap.
  revalidatePath("/chauffeur", "layout");
  return successState(settingsSavedMessage(previous.regulatorPhone, parsed.data.regulatorPhone));
}

export async function saveTraffic(_state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const values = readForm(formData);
  const [settings, zones] = await Promise.all([getSettings(db), loadTrafficZones(db)]);
  const parsed = trafficSchema(zones).safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);

  const update = toTrafficUpdate(parsed.data, zones);
  if (!trafficChanged(settings, zones, update)) return successState("Réglage du trafic inchangé.");
  await db.$transaction(async (tx) => {
    await tx.appSettings.update({ where: { id: 1 }, data: { ...update.settings, trafficChangedAt: new Date() } });
    for (const { id, ...data } of update.zones) await tx.trafficZone.update({ where: { id }, data });
    await audit(tx, user, {
      action: "traffic.update",
      entity: "AppSettings",
      entityId: "1",
      details: trafficChanges(settings, zones, update),
    });
  });
  revalidatePath("/parametres");
  return successState(
    update.settings.trafficEnabled
      ? "Trafic enregistré\u00a0: il s'appliquera au prochain calcul des tournées. Les plannings déjà calculés ne changent pas."
      : "Trafic désactivé\u00a0: le prochain calcul des tournées utilisera les temps à circulation fluide. Les plannings déjà calculés ne changent pas.",
  );
}

/** Applies the factors measured on real driving times (lib/domain/traffic-observed.ts), recomputed here. */
export async function applyObservedTraffic(): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  const [settings, zones] = await Promise.all([getSettings(db), loadTrafficZones(db)]);
  const observed = (await loadObservedFactors(db, settings, zones)).filter((cell) => cell.factor !== null);
  if (observed.length === 0) return messageState("Pas encore assez de trajets réels mesurés.");

  const updates = zones.flatMap((zone) => {
    const data = Object.fromEntries(
      TRAFFIC_BANDS.flatMap((band) => {
        const cell = observed.find((candidate) => candidate.zoneId === zone.id && candidate.band === band);
        return cell ? [[FACTOR_FIELDS[band], cell.factor]] : [];
      }),
    );
    return Object.keys(data).length > 0 ? [{ zone, data }] : [];
  });
  await db.$transaction(async (tx) => {
    for (const { zone, data } of updates) await tx.trafficZone.update({ where: { id: zone.id }, data });
    await tx.appSettings.update({ where: { id: 1 }, data: { trafficChangedAt: new Date() } });
    const details = Object.assign({}, ...updates.map(({ zone, data }) => prefixed(zone.name, changedFields(zone, data))));
    await audit(tx, user, { action: "traffic.apply_observed", entity: "AppSettings", entityId: "1", details });
  });
  revalidatePath("/parametres");
  const when = settings.trafficEnabled ? "elles comptent au prochain calcul des tournées" : "elles compteront une fois le trafic activé";
  return successState(`Valeurs observées appliquées (${observed.length} ${observed.length > 1 ? "cases" : "case"})\u00a0: ${when}.`);
}

/** Audit details of a traffic update: changed settings, then changed zone values as "<zone>.<field>". */
function trafficChanges(settings: AppSettings, zones: readonly TrafficZone[], update: TrafficUpdate): AuditDetails {
  const details: AuditDetails = changedFields(settings, update.settings);
  for (const { id, ...next } of update.zones) {
    const zone = zones.find((candidate) => candidate.id === id);
    if (zone) Object.assign(details, prefixed(zone.name, changedFields(zone, next)));
  }
  return details;
}

function prefixed(prefix: string, details: AuditDetails): AuditDetails {
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [`${prefix}.${key}`, value]));
}

/** First key of the lock of the objectives of a scope: "KPIT" (the planning locks use "OPTX", lib/planning/day-lock.ts). */
const KPI_TARGET_LOCK_NAMESPACE = 0x4b504954;

/**
 * Saves the reference values and objectives of the dashboard for one scope
 * (`depotId`, null for the whole company, KPI-09): the scope's rows are
 * replaced in one transaction, traced kpi_target.update with the changes.
 * Two saves of a scope are serialized by an advisory lock taken before the
 * rows are read: the unique index (indicator, depotId) does not cover the
 * company's rows (NULLs are distinct), and the trail's « from » is then the
 * value replaced. A unique violation left over (a depot created meanwhile…)
 * asks to reload rather than failing the page.
 */
export async function saveKpiTargets(depotId: string | null, _state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("REGULATOR");
  if (depotId !== null && !(await db.depot.findUnique({ where: { id: depotId }, select: { id: true } }))) {
    return messageState("Dépôt introuvable\u00a0: rechargez la page.");
  }
  const values = readForm(formData);
  const parsed = targetsSchema().safeParse(values);
  if (!parsed.success) return invalidState(parsed.error, values);

  const next = toTargetRows(parsed.data, depotId);
  let changed: boolean;
  try {
    changed = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${KPI_TARGET_LOCK_NAMESPACE}::int, hashtext(${depotId ?? "company"}))`;
      const previous = await tx.kpiTarget.findMany({ where: { depotId }, select: { indicator: true, depotId: true, reference: true, objective: true } });
      const changes = targetChanges(previous, next);
      if (Object.keys(changes).length === 0) return false;
      await tx.kpiTarget.deleteMany({ where: { depotId } });
      if (next.length > 0) await tx.kpiTarget.createMany({ data: next.map((row) => ({ ...row, updatedById: user.id })) });
      await audit(tx, user, {
        action: "kpi_target.update",
        entity: "KpiTarget",
        entityId: depotId,
        details: { ...(depotId ? { depotId } : {}), ...changes },
      });
      return true;
    });
  } catch (error) {
    if (isUniqueViolation(error, "indicator")) {
      return messageState("Les objectifs ont été modifiés entre-temps\u00a0: rechargez la page puis recommencez.");
    }
    throw error;
  }
  if (!changed) return successState("Objectifs inchangés.");
  revalidatePath("/parametres");
  revalidatePath("/tableau-de-bord");
  return successState("Objectifs enregistrés\u00a0: ils sont tracés en pointillés sur les graphiques du tableau de bord.");
}
