"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addDraftMove,
  DRAFT_MAX_MOVES,
  draftStorageKey,
  parseStoredMoves,
  removeDraftMove,
  type DraftMove,
  type DraftMoveResult,
  type DraftView,
} from "@/lib/planning/draft";
import { checkDraft, saveDraft } from "./actions";
import { usePlanningActivity } from "./planning-activity";

export type PlanningDraft = {
  moves: DraftMove[];
  /** The draft as last checked by the server (null: no move, or not checked yet). */
  view: DraftView | null;
  checking: boolean;
  /** Why the last drop, or a move of the draft, was refused (cleared by the next one). */
  refusal: string | null;
  /** The question asked before saving on a validated or started day. */
  question: string | null;
  drop: (tripId: string, toVehicleId: string | null) => void;
  remove: (tripId: string) => void;
  cancel: () => void;
  save: (confirmed: string | null) => void;
  retry: () => void;
  dismissRefusal: () => void;
  dismissQuestion: () => void;
};

/** « Course de MARTIN Jeanne : Taxi 4 est en pause de 12:00 à 12:45. » (`nameOf`: the patient). */
function refusalText(refused: readonly Extract<DraftMoveResult, { ok: false }>[], nameOf: (tripId: string) => string): string | null {
  if (refused.length === 0) return null;
  const [first] = refused;
  if (!first) return null;
  const more = refused.length > 1 ? ` (et ${refused.length - 1} autre${refused.length > 2 ? "s" : ""} modification${refused.length > 2 ? "s" : ""} retirée${refused.length > 2 ? "s" : ""})` : "";
  return `Déplacement refusé pour la course de ${nameOf(first.tripId)}\u00a0: ${first.reason}${more}`;
}

/**
 * The drag-and-drop draft of the timeline (INS-03): the moves dropped, kept for the date in the
 * tab's session (a reload or a visit to another page keeps them), checked by the server after each
 * drop and whenever the plan's version changes (another action saved meanwhile), saved at once by
 * « Enregistrer ». A move the server refuses is taken out of the draft, with why; one that no longer
 * changes anything (the trip is already there) goes silently; a check that does not answer brings the
 * draft back to the last one checked.
 */
export function usePlanningDraft({
  date,
  version,
  homeOf,
  nameOf,
  onDropped,
}: {
  date: string;
  version: string;
  /** The vehicle of the trip in the plan in place (null: without a vehicle). */
  homeOf: (tripId: string) => string | null;
  nameOf: (tripId: string) => string;
  /** A drop that held, once checked: the board highlights its trip. */
  onDropped?: (tripId: string) => void;
}): PlanningDraft {
  const router = useRouter();
  const { run } = usePlanningActivity();
  const [moves, setMoves] = useState<DraftMove[]>([]);
  const [view, setView] = useState<DraftView | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  const [checking, startCheck] = useTransition();
  /** The check whose answer counts: an older one, answered late, is ignored. */
  const latest = useRef(0);
  /** The moves of the last check that succeeded: what `view` shows (a check that fails goes back to them). */
  const checkedMoves = useRef<DraftMove[]>([]);

  const store = useCallback(
    (next: readonly DraftMove[]) => {
      try {
        if (next.length > 0) window.sessionStorage.setItem(draftStorageKey(date), JSON.stringify(next));
        else window.sessionStorage.removeItem(draftStorageKey(date));
      } catch {
        // Private browsing without storage: the draft lives as long as the page.
      }
    },
    [date],
  );

  const check = useCallback(
    (next: DraftMove[], dropped: string | null = null) => {
      setQuestion(null);
      if (next.length === 0) {
        checkedMoves.current = [];
        setMoves([]);
        setView(null);
        store([]);
        return;
      }
      setMoves(next);
      store(next);
      const ticket = ++latest.current;
      // The check did not answer (optimizer down, connection lost): the draft goes back to what was last
      // checked, as the timeline shows it, never a move saved whose effects were not seen. A draft never
      // checked yet (restored on loading) stays, unchecked: « Enregistrer » waits for « Vérifier de nouveau ».
      const failed = (error: string) => {
        const back = checkedMoves.current;
        if (back.length > 0) {
          setMoves(back);
          store(back);
        } else setView(null);
        setRefusal(back.length > 0 && back !== next ? `${error} Le brouillon revient à sa dernière vérification.` : error);
      };
      startCheck(async () => {
        try {
          const result = await checkDraft(date, next);
          if (!result || ticket !== latest.current) return;
          if (!result.ok) {
            failed(result.error);
            if (result.stale) router.refresh();
            return;
          }
          const refused = result.view.moves.filter((m): m is Extract<DraftMoveResult, { ok: false }> => !m.ok);
          // Kept: the moves that hold. A refused one goes, with why; one the server answered nothing for
          // (the trip is already where it puts it: the plan changed meanwhile) goes silently.
          const kept = next.filter((m) => result.view.moves.some((r) => r.ok && r.tripId === m.tripId));
          checkedMoves.current = kept;
          setRefusal(refusalText(refused, nameOf));
          setMoves(kept);
          store(kept);
          setView(kept.length > 0 ? result.view : null);
          if (dropped && kept.some((m) => m.tripId === dropped)) onDropped?.(dropped);
          // Checked on a newer plan than the page shows: the page catches up (the draft is checked again on it).
          if (result.view.version !== version) router.refresh();
        } catch {
          if (ticket === latest.current) failed("La vérification du brouillon n'a pas abouti (connexion au serveur perdue\u202f?)\u00a0: réessayez.");
        }
      });
    },
    [date, version, nameOf, router, store, onDropped],
  );

  // The draft kept for this date, checked again on the plan shown; and again whenever that plan changes.
  const restored = useRef(false);
  useEffect(() => {
    const stored = restored.current ? moves : readStored(date);
    restored.current = true;
    if (stored.length > 0) check(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on the plan's version only
  }, [version]);

  // Leaving the page with moves not saved: the browser asks (the draft is kept for the tab anyway).
  useEffect(() => {
    if (moves.length === 0) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [moves.length]);

  const drop = useCallback(
    (tripId: string, toVehicleId: string | null) => {
      const next = addDraftMove(moves, { tripId, toVehicleId }, homeOf);
      if (next.length > DRAFT_MAX_MOVES) {
        setRefusal(`Un brouillon garde au plus ${DRAFT_MAX_MOVES} modifications\u00a0: enregistrez ou annulez d'abord.`);
        return;
      }
      setRefusal(null);
      check(next, tripId);
    },
    [moves, homeOf, check],
  );

  const remove = useCallback((tripId: string) => check(removeDraftMove(moves, tripId)), [moves, check]);
  const cancel = useCallback(() => {
    latest.current += 1;
    setRefusal(null);
    check([]);
  }, [check]);

  const save = useCallback(
    (confirmed: string | null) => {
      if (moves.length === 0) return;
      setQuestion(null);
      const saved = moves;
      run(`Enregistrement de ${saved.length > 1 ? `${saved.length} modifications` : "la modification"}…`, () => saveDraft(date, version, saved, confirmed), {
        onResult: (result) => {
          if (result.ok) {
            latest.current += 1;
            checkedMoves.current = [];
            setMoves([]);
            setView(null);
            setRefusal(null);
            store([]);
          } else if (result.needsConfirmation) setQuestion(result.error);
          else if (result.recheck) check(saved);
        },
      });
    },
    [moves, run, date, version, store, check],
  );

  /** « Vérifier de nouveau » : a draft whose check did not answer is checked again, as it is. */
  const retry = useCallback(() => {
    setRefusal(null);
    check(moves);
  }, [moves, check]);

  const dismissRefusal = useCallback(() => setRefusal(null), []);
  const dismissQuestion = useCallback(() => setQuestion(null), []);
  return {
    moves,
    view,
    checking,
    refusal,
    question,
    drop,
    remove,
    cancel,
    save,
    retry,
    dismissRefusal,
    dismissQuestion,
  };
}

function readStored(date: string): DraftMove[] {
  try {
    return parseStoredMoves(window.sessionStorage.getItem(draftStorageKey(date)));
  } catch {
    return [];
  }
}
