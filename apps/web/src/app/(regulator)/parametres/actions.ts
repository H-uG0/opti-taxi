"use server";

import { revalidatePath } from "next/cache";
import type { AppSettings, TrafficZone } from "@prisma/client";
import { audit, changedFields, type AuditDetails } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/domain/settings";
import { FACTOR_FIELDS, loadTrafficZones, TRAFFIC_BANDS } from "@/lib/domain/traffic";
import { loadObservedFactors } from "@/lib/domain/traffic-observed";
import { invalidState, messageState, readForm, successState, type FormState } from "@/lib/forms";
import { settingsSavedMessage, settingsSchema } from "./schema";
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
      ? "Trafic enregistré : il s'appliquera au prochain calcul des tournées. Les plannings déjà calculés ne changent pas."
      : "Trafic désactivé : le prochain calcul des tournées utilisera les temps à circulation fluide. Les plannings déjà calculés ne changent pas.",
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
  return successState(`Valeurs observées appliquées (${observed.length} ${observed.length > 1 ? "cases" : "case"}) : ${when}.`);
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
