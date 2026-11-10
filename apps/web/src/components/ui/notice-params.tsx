"use client";

import { useEffect } from "react";

/** One-shot query parameters of the save rule: « ?cree=1 » after a creation, « ?enregistre=1 » after a save. */
export const NOTICE_PARAMS = ["cree", "enregistre"] as const;

/** The query string without the one-shot parameters (null: nothing to drop). */
export function withoutNoticeParams(search: string): string | null {
  const params = new URLSearchParams(search);
  if (!NOTICE_PARAMS.some((name) => params.has(name))) return null;
  for (const name of NOTICE_PARAMS) params.delete(name);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/**
 * Drops the one-shot parameters from the address once their notice is on screen
 * (history.replaceState, which Next.js follows): a reload, a back navigation, a bookmark or a
 * later action on the same page (« Désactiver » refreshes the same address) no longer shows
 * « Modifications enregistrées. » again. Rendered next to the notice.
 */
export function DropNoticeParams() {
  useEffect(() => {
    const search = withoutNoticeParams(window.location.search);
    if (search !== null) window.history.replaceState(null, "", `${window.location.pathname}${search}${window.location.hash}`);
  }, []);
  return null;
}
