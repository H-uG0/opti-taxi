/**
 * « Replacer les courses » after an interruption (DAY-03): the summary of what the bulk placement did.
 * Pure; the server action (planning/actions.ts replaceTrips) places each trip as « Appliquer » does.
 */
import { formatMinute } from "@/lib/time";

export type ReplaceOutcome =
  | { patient: string; placed: true; vehicleId: string; pickupMinute: number }
  | { patient: string; placed: false; reason: string };

/** A vehicle « Où placer » refused for the trip, with why (to follow its name). */
export type ReplaceRefusal = { vehicleId: string; kind: string; reason: string };

/**
 * Why no vehicle took the trip: the most frequent refusal, said by one vehicle, and how many others were
 * refused for the same reason. « aucune place : VSL 37 prendrait en charge à 11:30…, de même que 4 autres
 * véhicules ».
 */
export function noPlaceReason(rejected: readonly ReplaceRefusal[], labels: ReadonlyMap<string, string>): string {
  if (rejected.length === 0) return "aucun véhicule n'a de place";
  const counts = new Map<string, number>();
  for (const refusal of rejected) counts.set(refusal.kind, (counts.get(refusal.kind) ?? 0) + 1);
  // The most frequent kind; on a tie, the one met first (the optimizer's order).
  let kind = rejected[0]!.kind;
  for (const refusal of rejected) if ((counts.get(refusal.kind) ?? 0) > (counts.get(kind) ?? 0)) kind = refusal.kind;
  const first = rejected.find((refusal) => refusal.kind === kind)!;
  const others = (counts.get(kind) ?? 1) - 1;
  const label = labels.get(first.vehicleId) ?? "un véhicule";
  const same = others > 0 ? `, de même que ${plural(others, "autre véhicule", "autres véhicules")}` : "";
  return `aucune place\u00a0: ${label} ${trimmed(first.reason)}${same}`;
}

/** The place « Replacer » takes: the earliest pickup for a patient waiting by a vehicle, the best margin otherwise. */
export function chosenPlace<O extends { pickupMinute: number }>(options: readonly O[], continuation: boolean): O | undefined {
  if (!continuation) return options[0];
  return options.reduce<O | undefined>((best, option) => (best === undefined || option.pickupMinute < best.pickupMinute ? option : best), undefined);
}

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
