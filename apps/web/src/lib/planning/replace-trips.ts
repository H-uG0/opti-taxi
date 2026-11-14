/**
 * « Replacer les courses » after an interruption (DAY-03): the summary of what the bulk placement did.
 * Pure; the server action (planning/actions.ts replaceTrips) places each trip as « Appliquer » does.
 */
import { formatMinute } from "@/lib/time";

export type ReplaceOutcome =
  | { patient: string; placed: true; vehicleId: string; pickupMinute: number }
  | { patient: string; placed: false; reason: string };

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/** Without the final full stop of a reason, to list it. */
function trimmed(text: string): string {
  return text.replace(/[.\s]+$/, "");
}

/**
 * « 2 courses replacées (MARTIN Jeanne sur Taxi 4 à 11:40, …). 1 course non replacée : DUPONT Paul, aucune place
 * (…). » `left`: the trips left without a place, still listed under « À placer ».
 */
export function replaceSummary(outcomes: readonly ReplaceOutcome[], labels: ReadonlyMap<string, string>): { text: string; left: number } {
  const placed = outcomes.filter((o): o is Extract<ReplaceOutcome, { placed: true }> => o.placed);
  const left = outcomes.filter((o): o is Extract<ReplaceOutcome, { placed: false }> => !o.placed);
  const parts: string[] = [];
  if (outcomes.length === 0) return { text: "Aucune course à replacer\u00a0: elles ont déjà un véhicule.", left: 0 };
  if (placed.length > 0) {
    const where = placed.map((o) => `${o.patient} sur ${labels.get(o.vehicleId) ?? "un véhicule"} à ${formatMinute(o.pickupMinute)}`);
    parts.push(`${plural(placed.length, "course replacée", "courses replacées")} (${where.join(", ")}).`);
  }
  if (left.length > 0) {
    const why = left.map((o) => `${o.patient}, ${trimmed(o.reason.charAt(0).toLowerCase() + o.reason.slice(1))}`);
    const stay = left.length > 1 ? "Elles restent" : "Elle reste";
    parts.push(`${plural(left.length, "course non replacée", "courses non replacées")}\u00a0: ${why.join("\u202f; ")}. ${stay} dans «\u202fÀ placer\u202f».`);
  }
  return { text: parts.join(" "), left: left.length };
}
