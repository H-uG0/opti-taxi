"use client";

import { useSyncExternalStore } from "react";
import { WifiOff } from "lucide-react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** Banner shown while the phone reports no network (statuses cannot be sent). */
export function OfflineBanner() {
  const online = useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
  if (online) return null;
  return (
    <div role="status" className="flex items-start gap-2 bg-amber-400 px-4 py-2 text-sm font-semibold text-amber-950">
      <WifiOff aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>Hors connexion : les statuts ne peuvent pas être envoyés. Les informations affichées datent du dernier chargement.</span>
    </div>
  );
}
