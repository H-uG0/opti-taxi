"use client";

import dynamic from "next/dynamic";
import type { PlanningMapProps } from "./planning-map";

/** MapLibre needs the browser (WebGL, window): load the map on the client only. */
const PlanningMapClient = dynamic(() => import("./planning-map").then((m) => m.PlanningMap), {
  ssr: false,
  loading: () => (
    <div className="grid h-full min-h-80 place-items-center bg-slate-50 text-sm text-slate-500">Chargement de la carte…</div>
  ),
});

export function PlanningMapLazy(props: PlanningMapProps) {
  return <PlanningMapClient {...props} />;
}
