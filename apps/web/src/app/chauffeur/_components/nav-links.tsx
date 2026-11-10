"use client";

import { useSyncExternalStore } from "react";
import { Map as MapIcon, MapPin, Navigation, Navigation2 } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { navigationLinks } from "../_lib/links";
import { isApplePhone, isNavApp, NAV_APP_LABELS, NAV_APP_STORAGE_KEY, navAppHref, navAppsFor, type NavApp } from "../_lib/nav-apps";

const linkClass =
  "flex min-h-12 touch-manipulation flex-col items-center justify-center gap-0.5 rounded-xl border px-1 py-1.5 text-center text-sm font-semibold leading-tight text-slate-800 hover:bg-slate-50 active:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

const ICONS: Record<NavApp, React.ReactNode> = {
  google: <Navigation aria-hidden className="size-5 text-brand-700" />,
  waze: <Navigation2 aria-hidden className="size-5 text-sky-600" />,
  apple: <MapIcon aria-hidden className="size-5 text-slate-700" />,
  geo: <MapPin aria-hidden className="size-5 text-slate-600" />,
};

// The preferred app, shared by every stop card of the page (and other tabs through the storage event).
const listeners = new Set<() => void>();

function subscribePreference(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readPreference(): NavApp | null {
  try {
    const value = window.localStorage.getItem(NAV_APP_STORAGE_KEY);
    return isNavApp(value) ? value : null;
  } catch {
    return null;
  }
}

function savePreference(app: NavApp): void {
  try {
    window.localStorage.setItem(NAV_APP_STORAGE_KEY, app);
  } catch {
    // Storage refused (private browsing): the order simply stays the default one.
  }
  for (const listener of listeners) listener();
}

const noSubscription = () => () => undefined;
const applePhone = () => isApplePhone(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);

/**
 * "Itinéraire" buttons: Google Maps, Waze and the phone's own navigation
 * (Apple Plans on an iPhone, geo: elsewhere), the one used last first.
 * Rendered in the default order on the server, then adapted to the phone.
 */
export function NavLinks({ lat, lng, destination }: { lat: number; lng: number; destination: string }) {
  const preferred = useSyncExternalStore(subscribePreference, readPreference, () => null);
  const apple = useSyncExternalStore(noSubscription, applePhone, () => false);
  const links = navigationLinks({ lat, lng });
  if (!links) {
    return <p className="text-sm font-medium text-amber-800">Coordonnées GPS absentes&nbsp;: suivez l&apos;adresse.</p>;
  }
  return (
    <div role="group" aria-label={`Itinéraire vers ${destination}`}>
      <p aria-hidden className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Itinéraire
      </p>
      <div className="grid grid-cols-3 gap-2">
        {navAppsFor(apple, preferred).map((app) => (
          <a
            key={app}
            href={navAppHref(app, links)}
            onClick={() => savePreference(app)}
            {...(app === "geo" ? {} : { target: "_blank", rel: "noopener noreferrer" })}
            className={cn(linkClass, app === preferred ? "border-brand-600 bg-brand-50" : "border-slate-300 bg-white")}
          >
            {ICONS[app]}
            {NAV_APP_LABELS[app]}
          </a>
        ))}
      </div>
    </div>
  );
}
