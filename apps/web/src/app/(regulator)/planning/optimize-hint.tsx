"use client";

import { usePlanningActivity } from "./planning-activity";

/**
 * What to do on a day without routes: « Lancez « Optimiser demain » … »,
 * unless the optimizer is offline (OptimizerStatus), which disables that button.
 */
export function OptimizeHint({ label }: { label: string }) {
  const { optimizerOffline } = usePlanningActivity();
  if (optimizerOffline) return <>{optimizerOffline} Lancez «&#x202F;{label}&#x202F;» dès qu&apos;il répondra.</>;
  return <>Lancez «&#x202F;{label}&#x202F;» pour obtenir les tournées.</>;
}
