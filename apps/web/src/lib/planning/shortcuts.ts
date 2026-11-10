/**
 * Keyboard shortcuts of the planning (UX-08), documented by its « ? » help:
 * when a key press is a shortcut, and the order in which « N » walks through
 * « À traiter ». Pure: no React, no DOM beyond the event's target.
 */

export type ShortcutHelp = { keys: string[]; label: string };

/** What the « ? » help lists, in this order. */
export const PLANNING_SHORTCUTS: readonly ShortcutHelp[] = [
  { keys: ["/"], label: "Chercher un patient, un véhicule, un chauffeur" },
  { keys: ["["], label: "Jour précédent" },
  { keys: ["]"], label: "Jour suivant" },
  { keys: ["F"], label: "Figer ou défiger la course sélectionnée (recours exceptionnel\u00a0: va au bouton «\u202fDéfiger\u202f» sans l'activer)" },
  { keys: ["D"], label: "Aller à «\u00a0Déplacer vers…\u00a0» de la course sélectionnée" },
  { keys: ["N"], label: "Problème suivant de «\u00a0À traiter\u00a0»" },
  { keys: ["Échap"], label: "Désélectionner, fermer une liste" },
  { keys: ["?"], label: "Afficher ou masquer cette aide" },
];

/** In the frise (one Tab stop): the keys that move between vehicles and trips. */
export const TIMELINE_KEYS: readonly ShortcutHelp[] = [
  { keys: ["↑", "↓"], label: "Véhicule précédent, suivant" },
  { keys: ["←", "→"], label: "Course précédente, suivante sur la ligne" },
  { keys: ["Début", "Fin"], label: "Première, dernière course de la ligne" },
  { keys: ["Page préc.", "Page suiv."], label: "Dix lignes plus haut, plus bas" },
  { keys: ["Entrée"], label: "Sélectionner (une pastille «\u00a0+3\u00a0» ouvre sa liste)" },
];

type TargetLike = { closest?: (selector: string) => unknown; isContentEditable?: boolean } | null;

/** Inputs that take no text: a key pressed on them is free for the shortcuts (the zoom's radios, the filters' boxes). */
const NOT_TEXT = ["radio", "checkbox", "button", "submit", "reset", "range", "color", "file", "image"]
  .map((type) => `:not([type='${type}'])`)
  .join("");

/** True when a key typed there is text or belongs to a dialog (a shortcut must not steal it). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as TargetLike;
  if (!element || typeof element.closest !== "function") return false;
  return (
    element.isContentEditable === true ||
    element.closest(`input${NOT_TEXT}, textarea, select, [contenteditable='true'], [role='dialog'], [role='alertdialog']`) !== null
  );
}

type KeyLike = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  repeat?: boolean;
  defaultPrevented?: boolean;
  getModifierState?: (key: string) => boolean;
};

/**
 * Whether a key press may run a one-key shortcut: not while typing, not a
 * key held down (its repeats would undo or redo the action), not with Ctrl,
 * Alt or Cmd (the browser's own shortcuts). Except where a keyboard needs the
 * modifier to type the character: AltGr (Windows reports it as Ctrl + Alt)
 * and, on a Mac, Option, for « [ », « ] », « / », « ? » (never for a letter).
 */
export function isShortcutKey(e: KeyLike): boolean {
  if (e.defaultPrevented || e.repeat === true || isTypingTarget(e.target)) return false;
  if (e.metaKey) return false;
  if (!e.ctrlKey && !e.altKey) return true;
  if (e.getModifierState?.("AltGraph") === true) return true;
  // Option (⌥) on a Mac: `key` already holds the character it typed, e.g. « [ » for ⌥⇧5 on a French keyboard.
  const printedSign = e.key.length === 1 && !/\p{L}|\p{N}|\s/u.test(e.key);
  return e.altKey && !e.ctrlKey && printedSign;
}

export type IssueTarget = { kind: "trip" | "vehicle"; id: string };

/**
 * Entries of « À traiter » in the order the panel shows them: patients served
 * one way only, vehicles to review, returns to check, violations (their trip,
 * else their vehicle), trips without a vehicle, trips to review, locks
 * ignored. Each trip or vehicle once.
 */
export function issueTargets(args: {
  planned: boolean;
  unassigned: ReadonlyArray<{ tripId: string; servedPartner?: unknown }>;
  vehicleIssues: ReadonlyArray<{ vehicleId: string }>;
  returnsToCheck: readonly string[];
  violations: ReadonlyArray<{ tripId: string | null; vehicleId: string | null }>;
  staleTrips: ReadonlyArray<{ tripId: string }>;
  droppedLocks: ReadonlyArray<{ tripId: string }>;
}): IssueTarget[] {
  const list: IssueTarget[] = [];
  const seen = new Set<string>();
  const add = (kind: IssueTarget["kind"], id: string | null) => {
    if (!id || seen.has(`${kind}:${id}`)) return;
    seen.add(`${kind}:${id}`);
    list.push({ kind, id });
  };
  if (args.planned) for (const u of args.unassigned) if (u.servedPartner) add("trip", u.tripId);
  for (const issue of args.vehicleIssues) add("vehicle", issue.vehicleId);
  for (const id of args.returnsToCheck) add("trip", id);
  for (const v of args.violations) {
    if (v.tripId) add("trip", v.tripId);
    else add("vehicle", v.vehicleId);
  }
  for (const u of args.unassigned) if (!args.planned || !u.servedPartner) add("trip", u.tripId);
  for (const s of args.staleTrips) add("trip", s.tripId);
  for (const d of args.droppedLocks) add("trip", d.tripId);
  return list;
}

/**
 * The entry after the current selection (the first one when the selection is
 * not in the list), wrapping around; null when the list is empty.
 */
export function nextIssueTarget(
  targets: readonly IssueTarget[],
  selection: { tripId: string | null; vehicleId: string | null },
): { target: IssueTarget; index: number } | null {
  if (targets.length === 0) return null;
  const current = selection.tripId
    ? targets.findIndex((t) => t.kind === "trip" && t.id === selection.tripId)
    : selection.vehicleId
      ? targets.findIndex((t) => t.kind === "vehicle" && t.id === selection.vehicleId)
      : -1;
  const index = (current + 1) % targets.length;
  return { target: targets[index]!, index };
}
