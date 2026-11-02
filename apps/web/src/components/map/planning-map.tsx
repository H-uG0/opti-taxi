"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { LngLatBounds, MapLibreMap, NavigationControl, Popup, type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";
import { Maximize2 } from "lucide-react";
import { AXIS_CENTER, AXIS_ZOOM, configuredStyleUrl, OSM_RASTER_STYLE } from "./map-style";
import {
  allPoints,
  boundsOf,
  depotsCollection,
  routesCollection,
  selectionCollection,
  stopsCollection,
  unassignedCollection,
  type MapPoint,
  type MapTrip,
  type MapVehicle,
} from "./planning-geojson";

export type PlanningMapProps = {
  vehicles: MapVehicle[];
  trips: MapTrip[];
  selectedTripId: string | null;
  selectedVehicleId: string | null;
  onSelectTrip: (tripId: string) => void;
  onSelectVehicle: (vehicleId: string) => void;
  /** Changes when the dataset changes (e.g. the date): the map then refits. */
  datasetKey: string;
};

const STYLE_TIMEOUT_MS = 8_000;
const FIT_PADDING = 48;
const INTERACTIVE_LAYERS = ["stops", "unassigned", "routes-line"] as const;

type SetData = Parameters<GeoJSONSource["setData"]>[0];

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function setSource(map: MapLibreMap, id: string, data: unknown) {
  const source = map.getSource(id) as GeoJSONSource | undefined;
  source?.setData(data as SetData);
}

function fit(map: MapLibreMap, points: MapPoint[], animate: boolean) {
  const bounds = boundsOf(points);
  if (!bounds) return;
  map.fitBounds(new LngLatBounds(bounds[0], bounds[1]), {
    padding: FIT_PADDING,
    maxZoom: 13,
    duration: animate ? 500 : 0,
  });
}

function addPlanningLayers(map: MapLibreMap) {
  if (map.getSource("routes")) return;
  const empty = { type: "FeatureCollection", features: [] } as SetData;
  for (const id of ["routes", "stops", "depots", "unassigned", "selection"]) {
    map.addSource(id, { type: "geojson", data: empty });
  }
  map.addLayer({
    id: "routes-line",
    type: "line",
    source: "routes",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": ["get", "color"], "line-width": 3, "line-opacity": 0.85 },
  });
  map.addLayer({
    id: "selection-line",
    type: "line",
    source: "selection",
    filter: ["==", ["get", "role"], "line"],
    paint: { "line-color": "#0f172a", "line-width": 2.5, "line-dasharray": [2, 1.5] },
  });
  map.addLayer({
    id: "depots",
    type: "circle",
    source: "depots",
    paint: {
      "circle-radius": 7,
      "circle-color": "#0f172a",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2.5,
    },
  });
  map.addLayer({
    id: "unassigned",
    type: "circle",
    source: "unassigned",
    paint: {
      "circle-radius": 5,
      "circle-color": "#ffffff",
      "circle-stroke-color": "#475569",
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: "stops",
    type: "circle",
    source: "stops",
    paint: {
      "circle-radius": 5,
      "circle-color": ["case", ["==", ["get", "kind"], "PICKUP"], ["get", "color"], "#ffffff"],
      "circle-stroke-color": ["case", ["==", ["get", "kind"], "PICKUP"], "#ffffff", ["get", "color"]],
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: "selection-points",
    type: "circle",
    source: "selection",
    filter: ["!=", ["get", "role"], "line"],
    paint: {
      "circle-radius": 9,
      "circle-color": "rgba(255,255,255,0)",
      "circle-stroke-color": "#0f172a",
      "circle-stroke-width": 3,
    },
  });
}

/** Opacity / width of each layer for the current selection. */
function applySelection(map: MapLibreMap, vehicleId: string | null, tripId: string | null) {
  if (!map.getLayer("routes-line")) return;
  const isVehicle = ["==", ["get", "vehicleId"], vehicleId ?? ""];
  map.setPaintProperty("routes-line", "line-opacity", vehicleId ? ["case", isVehicle, 1, 0.22] : 0.85);
  map.setPaintProperty("routes-line", "line-width", vehicleId ? ["case", isVehicle, 5, 2.5] : 3);
  map.setPaintProperty("stops", "circle-opacity", vehicleId ? ["case", isVehicle, 1, 0.3] : 1);
  map.setPaintProperty("stops", "circle-stroke-opacity", vehicleId ? ["case", isVehicle, 1, 0.3] : 1);
  map.setPaintProperty(
    "stops",
    "circle-radius",
    tripId ? ["case", ["==", ["get", "tripId"], tripId], 8, 5] : 5,
  );
}

export function PlanningMap({
  vehicles,
  trips,
  selectedTripId,
  selectedVehicleId,
  onSelectTrip,
  onSelectVehicle,
  datasetKey,
}: PlanningMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  // Client-only component (loaded with ssr: false): reading the env here is safe.
  const [usingFallback, setUsingFallback] = useState(() => configuredStyleUrl() === null);
  const [webglAvailable] = useState(supportsWebGL);
  const callbacks = useRef({ onSelectTrip, onSelectVehicle });
  const selectionFromMap = useRef(false);
  const fittedKey = useRef<string | null>(null);

  useEffect(() => {
    callbacks.current = { onSelectTrip, onSelectVehicle };
  }, [onSelectTrip, onSelectVehicle]);

  // Create the map once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !webglAvailable) return;
    const styleUrl = configuredStyleUrl();
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container,
        style: styleUrl ?? OSM_RASTER_STYLE,
        center: AXIS_CENTER,
        zoom: AXIS_ZOOM,
        attributionControl: { compact: true },
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      });
    } catch (error) {
      // Never let the map take the planning page down with it.
      console.error("[planning-map] MapLibre could not start", error);
      return;
    }
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");

    // Fall back to the raster style when the vector style cannot be fetched or
    // parsed in time. Errors once the style is parsed (a missing tile…) are not
    // a reason to switch.
    let styleParsed = false;
    let fellBack = styleUrl === null;
    const fallBack = () => {
      if (styleParsed || fellBack) return;
      fellBack = true;
      setUsingFallback(true);
      map.setStyle(OSM_RASTER_STYLE);
    };
    const timer = window.setTimeout(fallBack, STYLE_TIMEOUT_MS);
    map.once("styledata", () => {
      styleParsed = true;
      window.clearTimeout(timer);
    });
    map.on("error", () => {
      if (!styleParsed) fallBack();
    });

    const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 10, maxWidth: "280px" });
    const showPopup = (e: MapLayerMouseEvent) => {
      const feature = e.features?.[0];
      const title = feature?.properties?.title;
      map.getCanvas().style.cursor = "pointer";
      if (typeof title === "string") popup.setLngLat(e.lngLat).setText(title).addTo(map);
    };
    const hidePopup = () => {
      map.getCanvas().style.cursor = "";
      popup.remove();
    };

    map.on("load", () => {
      window.clearTimeout(timer);
      addPlanningLayers(map);
      // Layer listeners only once the layers exist (querying a missing layer emits errors).
      for (const layer of [...INTERACTIVE_LAYERS, "depots"]) {
        map.on("mousemove", layer, showPopup);
        map.on("mouseleave", layer, hidePopup);
      }
      setReady(true);
    });
    map.on("click", (e) => {
      const hits = map.queryRenderedFeatures(e.point, { layers: [...INTERACTIVE_LAYERS].filter((l) => map.getLayer(l)) });
      const hit = hits[0];
      if (!hit) return;
      const props = hit.properties ?? {};
      selectionFromMap.current = true;
      if (typeof props.tripId === "string") callbacks.current.onSelectTrip(props.tripId);
      else if (typeof props.vehicleId === "string") callbacks.current.onSelectVehicle(props.vehicleId);
    });

    return () => {
      window.clearTimeout(timer);
      popup.remove();
      map.remove();
      mapRef.current = null;
    };
  }, [webglAvailable]);

  // Data.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    setSource(map, "routes", routesCollection(vehicles));
    setSource(map, "stops", stopsCollection(vehicles));
    setSource(map, "depots", depotsCollection(vehicles));
    setSource(map, "unassigned", unassignedCollection(trips));
    if (fittedKey.current !== datasetKey) {
      fittedKey.current = datasetKey;
      fit(map, allPoints(vehicles, trips), false);
    }
  }, [ready, vehicles, trips, datasetKey]);

  // Selection.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const trip = selectedTripId ? (trips.find((t) => t.id === selectedTripId) ?? null) : null;
    setSource(map, "selection", selectionCollection(trip));
    applySelection(map, selectedVehicleId, selectedTripId);

    if (selectionFromMap.current) {
      selectionFromMap.current = false;
      return;
    }
    if (trip) {
      fit(map, [trip.pickup, trip.dropoff], true);
    } else if (selectedVehicleId) {
      const vehicle = vehicles.find((v) => v.id === selectedVehicleId);
      if (vehicle) fit(map, [vehicle.depot, ...vehicle.stops], true);
    }
  }, [ready, selectedTripId, selectedVehicleId, trips, vehicles]);

  return (
    <div className="relative h-full min-h-80">
      {/* maplibre-gl.css sets `.maplibregl-map { position: relative }` outside any cascade layer, which
          beats Tailwind's layered `absolute` on the same element: the map gets its own child, sized by
          an absolutely positioned wrapper. */}
      <div className="absolute inset-0">
        <div ref={containerRef} className="size-full" role="region" aria-label="Carte des tournées" />
      </div>
      <div className="absolute left-2 top-2 flex flex-col items-start gap-1.5">
        <button
          type="button"
          onClick={() => {
            const map = mapRef.current;
            if (map) fit(map, allPoints(vehicles, trips), true);
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white/95 px-2 py-1 text-xs font-medium text-slate-700 shadow-xs hover:bg-white focus-visible:outline-2 focus-visible:outline-brand-600"
        >
          <Maximize2 aria-hidden className="size-3.5" />
          Vue d&apos;ensemble
        </button>
        {usingFallback ? (
          <p className="rounded bg-white/90 px-1.5 py-0.5 text-[11px] text-slate-500">Fond de carte OpenStreetMap (raster)</p>
        ) : null}
      </div>
      {!ready ? (
        <div className="absolute inset-0 grid place-items-center bg-slate-50 px-6 text-center text-sm text-slate-500">
          {webglAvailable
            ? "Chargement de la carte…"
            : "Carte indisponible : WebGL est désactivé dans ce navigateur. La frise et les listes restent utilisables."}
        </div>
      ) : null}
    </div>
  );
}

export default PlanningMap;
