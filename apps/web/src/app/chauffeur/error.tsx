"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";

/** Unexpected error on the roadmap (server unreachable, database down…). */
export default function DriverRoadmapError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className="space-y-4 rounded-2xl border border-red-200 bg-white px-5 py-8 text-center">
      <TriangleAlert aria-hidden className="mx-auto size-10 text-red-600" />
      <div>
        <p className="text-lg font-semibold text-slate-900">Feuille de route indisponible</p>
        <p className="mt-1 text-sm text-slate-600">
          Le serveur ne répond pas ou le réseau est coupé. Réessayez dans un instant ; si le problème continue, appelez la régulation.
        </p>
      </div>
      <button
        type="button"
        onClick={() => retry()}
        className="inline-flex min-h-12 touch-manipulation items-center justify-center rounded-xl bg-brand-700 px-6 text-base font-semibold text-white hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
      >
        Réessayer
      </button>
    </div>
  );
}
