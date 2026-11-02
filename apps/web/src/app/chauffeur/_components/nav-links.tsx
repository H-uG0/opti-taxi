import { MapPin, Navigation, Navigation2 } from "lucide-react";
import { navigationLinks } from "../_lib/links";

const linkClass =
  "flex min-h-12 touch-manipulation flex-col items-center justify-center gap-0.5 rounded-xl border border-slate-300 bg-white px-1 py-1.5 text-center text-sm font-semibold leading-tight text-slate-800 hover:bg-slate-50 active:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

/** "Itinéraire" buttons: Google Maps, Waze and the phone's own GPS (geo: URI). */
export function NavLinks({ lat, lng, destination }: { lat: number; lng: number; destination: string }) {
  const links = navigationLinks({ lat, lng });
  if (!links) {
    return <p className="text-sm font-medium text-amber-800">Coordonnées GPS absentes : suivez l&apos;adresse.</p>;
  }
  return (
    <div role="group" aria-label={`Itinéraire vers ${destination}`}>
      <p aria-hidden className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Itinéraire
      </p>
      <div className="grid grid-cols-3 gap-2">
        <a href={links.googleMaps} target="_blank" rel="noopener noreferrer" className={linkClass}>
          <Navigation aria-hidden className="size-5 text-brand-700" />
          Google Maps
        </a>
        <a href={links.waze} target="_blank" rel="noopener noreferrer" className={linkClass}>
          <Navigation2 aria-hidden className="size-5 text-sky-600" />
          Waze
        </a>
        <a href={links.geo} className={linkClass}>
          <MapPin aria-hidden className="size-5 text-slate-600" />
          Autre GPS
        </a>
      </div>
    </div>
  );
}
