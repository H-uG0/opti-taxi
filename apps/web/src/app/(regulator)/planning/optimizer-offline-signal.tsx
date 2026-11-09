"use client";

import { useEffect } from "react";
import { usePlanningActivity } from "./planning-activity";

/**
 * Rendered by OptimizerStatus when the optimizer did not answer: the actions
 * that need it (« Optimiser », « Déplacer », « Revenir au planning précédent »)
 * are disabled with this reason.
 */
export function OptimizerOfflineSignal({ reason }: { reason: string }) {
  const { setOptimizerOffline } = usePlanningActivity();
  useEffect(() => {
    setOptimizerOffline(reason);
    return () => setOptimizerOffline(null);
  }, [reason, setOptimizerOffline]);
  return null;
}
