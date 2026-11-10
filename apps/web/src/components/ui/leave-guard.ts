"use client";

import { useEffect } from "react";

/**
 * Unsaved changes on screen (Équipages): leaving the page or its date asks
 * first. Closing or reloading the tab gets the browser's own question
 * (beforeunload); a link of the application (menu, « Jour suivant ») and the
 * date field of DateNav get `message` in a confirmation. A link to the same
 * page and date (a filter, an anchor) is not a departure: the form stays
 * mounted and keeps the changes.
 */
let pending: string | null = null;

/** True when nothing is pending or the user agrees to lose it. */
export function confirmLeave(): boolean {
  return pending === null || window.confirm(pending);
}

/** The address leaves the page shown: another path, or the same path for another date. */
export function leavesPage(target: URL, current: URL): boolean {
  if (target.origin !== current.origin) return false;
  return target.pathname !== current.pathname || target.searchParams.get("date") !== current.searchParams.get("date");
}

export function useLeaveGuard(message: string | null) {
  useEffect(() => {
    if (message === null) return;
    pending = message;
    const onUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    // On window, in the capture phase: before Next.js's <Link> handler, which navigates on the client.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      if (!leavesPage(new URL(link.href, window.location.href), new URL(window.location.href))) return;
      if (window.confirm(message)) {
        // Agreed: a full page load does not ask a second time.
        window.removeEventListener("beforeunload", onUnload);
      } else {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("click", onClick, true);
    return () => {
      if (pending === message) pending = null;
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("click", onClick, true);
    };
  }, [message]);
}
