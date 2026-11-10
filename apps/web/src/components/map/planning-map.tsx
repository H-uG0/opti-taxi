"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { LngLatBounds, MapLibreMap, NavigationControl, Popup, type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";
import { Focus, Maximize2, Map as MapIcon } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { VEHICLE_TYPE_SHORT } from "@/lib/labels";
import { diamondIcon, STOP_ICON_PATTERN, stopIcon, warningIcon, type StopShapeType } from "./map-icons";
import { AXIS_CENTER, AXIS_ZOOM, configuredStyleUrl, OSM_RASTER_STYLE } from "./map-style";
import {
  allPoints,
  boundsOf,
  depotsCollection,
  routesCollection,
  selectionCollection,
  selectionKey,
  shouldFitSelection,
  stopsCollection,
  unassignedCollection,
  violationsCollection,
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
  /** Whether the frame includes the trips without a vehicle (not when the map is narrowed to depots). */
  fitUnassigned?: boolean;
  /** Only the selection is shown (« Sélection seule »). */
  selectionOnly?: boolean;
  /** Turns « Sélection seule » on or off; null: the button is disabled (off, and nothing selected). */
  onSelectionOnlyChange?: ((on: boolean) => void) | null;
  /** « Sélection seule » is on but waits for a selection (the map shows everything meanwhile). */
  selectionOnlyWaiting?: boolean;
  /** The day has been optimized: a trip without a vehicle is « à placer » (diamonds); before, a plain pick-up « à planifier ». */
  planned?: boolean;
};

/** Amber of a trip without a vehicle (the timeline's « À placer »). */
const UNASSIGNED_COLOR = "#b45309";

const STYLE_TIMEOUT_MS = 8_000;
const FIT_PADDING = 48;
const INTERACTIVE_LAYERS = ["violations", "stops", "unassigned-points", "pending-points", "unassigned-line", "routes-line"] as const;
/** Stops drawn at twice their size for sharp screens: 15 px. */
const STOP_ICON_PX = 30;

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
  // Drawn at twice their size for sharp screens: 16 px diamonds, an 18 px warning sign.
  if (!map.hasImage("unassigned-pickup")) map.addImage("unassigned-pickup", diamondIcon(32, UNASSIGNED_COLOR, false), { pixelRatio: 2 });
  if (!map.hasImage("unassigned-dropoff")) map.addImage("unassigned-dropoff", diamondIcon(32, UNASSIGNED_COLOR, true), { pixelRatio: 2 });
  if (!map.hasImage("violation")) map.addImage("violation", warningIcon(36), { pixelRatio: 2 });
  const empty = { type: "FeatureCollection", features: [] } as SetData;
  for (const id of ["routes", "stops", "depots", "unassigned", "violations", "selection"]) {
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
    id: "unassigned-line",
    type: "line",
    source: "unassigned",
    filter: ["==", ["get", "role"], "line"],
    layout: { "line-cap": "round" },
    paint: { "line-color": UNASSIGNED_COLOR, "line-width": 2.5, "line-dasharray": [1.5, 1.5] },
  });
  map.addLayer({
    id: "pending-points",
    type: "circle",
    source: "unassigned",
    filter: ["==", ["get", "role"], "pending"],
    paint: {
      "circle-radius": 5,
      "circle-color": "#ffffff",
      "circle-stroke-color": "#475569",
      "circle-stroke-width": 2,
    },
  });
  // The shape tells the vehicle's type, the color the vehicle; the images are drawn when first needed (stopImage).
  map.addLayer({
    id: "stops",
    type: "symbol",
    source: "stops",
    layout: {
      "icon-image": ["concat", "stop:", ["get", "type"], ":", ["get", "kind"], ":", ["get", "color"]],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });
  map.addLayer({
    id: "unassigned-points",
    type: "symbol",
    source: "unassigned",
    filter: ["match", ["get", "role"], ["pickup", "dropoff"], true, false],
    layout: {
      "icon-image": ["case", ["==", ["get", "role"], "pickup"], "unassigned-pickup", "unassigned-dropoff"],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });
  map.addLayer({
    id: "violations",
    type: "symbol",
    source: "violations",
    layout: {
      "icon-image": "violation",
      "icon-offset": [7, -7],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
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
  map.setPaintProperty("stops", "icon-opacity", vehicleId ? ["case", isVehicle, 1, 0.3] : 1);
  map.setLayoutProperty("stops", "icon-size", tripId ? ["case", ["==", ["get", "tripId"], tripId], 1.5, 1] : 1);
}

/** The image of a stop the style asks for (« stop:VSL:PICKUP:#1d4ed8 »), drawn once. */
function addStopImage(map: MapLibreMap, id: string) {
  const match = STOP_ICON_PATTERN.exec(id);
  if (!match || map.hasImage(id)) return;
  const [, type, kind, color] = match;
  map.addImage(id, stopIcon(STOP_ICON_PX, type as StopShapeType, color!, kind as "PICKUP" | "DROPOFF"), { pixelRatio: 2 });
}

export function PlanningMap({
  vehicles,
  trips,
  selectedTripId,
  selectedVehicleId,
  onSelectTrip,
  onSelectVehicle,
  datasetKey,
  fitUnassigned = true,
  selectionOnly = false,
  onSelectionOnlyChange = null,
  selectionOnlyWaiting = false,
  planned = true,
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
  /** Selection the map last fitted to (selectionKey). */
  const fittedSelection = useRef<string | null>(null);
  /** The current selection, read by the click handler (created once). */
  const currentTripId = useRef(selectedTripId);

  useEffect(() => {
    callbacks.current = { onSelectTrip, onSelectVehicle };
  }, [onSelectTrip, onSelectVehicle]);

  useEffect(() => {
    currentTripId.current = selectedTripId;
  }, [selectedTripId]);

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

    map.on("styleimagemissing", (e: { id: string }) => addStopImage(map, e.id));
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
      if (typeof props.tripId === "string") {
        // The trip already selected: the selection does not change, so no effect would clear the flag.
        if (props.tripId === currentTripId.current) return;
        selectionFromMap.current = true;
        callbacks.current.onSelectTrip(props.tripId);
      } else if (typeof props.vehicleId === "string") {
        // A vehicle click always changes the selection (select, or toggle off).
        selectionFromMap.current = true;
        callbacks.current.onSelectVehicle(props.vehicleId);
      }
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
    setSource(map, "unassigned", unassignedCollection(trips, planned));
    setSource(map, "violations", violationsCollection(vehicles, trips));
    if (fittedKey.current !== datasetKey) {
      fittedKey.current = datasetKey;
      fit(map, allPoints(vehicles, trips, fitUnassigned), false);
    }
  }, [ready, vehicles, trips, datasetKey, fitUnassigned, planned]);

  // Selection.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const trip = selectedTripId ? (trips.find((t) => t.id === selectedTripId) ?? null) : null;
    setSource(map, "selection", selectionCollection(trip));
    applySelection(map, selectedVehicleId, selectedTripId);

    const key = selectionKey(selectedTripId, selectedVehicleId);
    const fromMap = selectionFromMap.current;
    selectionFromMap.current = false;
    const fitNow = shouldFitSelection(fittedSelection.current, key, fromMap);
    fittedSelection.current = key;
    if (!fitNow) return;
    if (trip) {
      fit(map, [trip.pickup, trip.dropoff], true);
    } else if (selectedVehicleId) {
      const vehicle = vehicles.find((v) => v.id === selectedVehicleId);
      if (vehicle) fit(map, [vehicle.depot, ...vehicle.stops], true);
    }
  }, [ready, selectedTripId, selectedVehicleId, trips, vehicles]);

  return (
    <div className="relative h-full min-h-32">
      {/* maplibre-gl.css sets `.maplibregl-map { position: relative }` outside any cascade layer, which
          beats Tailwind's layered `absolute` on the same element: the map gets its own child, sized by
          an absolutely positioned wrapper. */}
      {/* The card does not clip (the legend may open over the panel above): the map clips itself. */}
      <div className="absolute inset-0 overflow-hidden rounded-lg">
        <div ref={containerRef} className="size-full" role="region" aria-label="Carte des tournées" />
      </div>
      <div className="absolute left-2 top-2 flex flex-col items-start gap-1.5">
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => {
              const map = mapRef.current;
              if (map) fit(map, allPoints(vehicles, trips, fitUnassigned), true);
            }}
            className={MAP_BUTTON}
          >
            <Maximize2 aria-hidden className="size-3.5" />
            Vue d&apos;ensemble
          </button>
          <button
            type="button"
            aria-pressed={selectionOnly}
            disabled={onSelectionOnlyChange === null}
            onClick={() => onSelectionOnlyChange?.(!selectionOnly)}
            title={
              onSelectionOnlyChange === null
                ? "Sélectionnez une course ou un véhicule pour ne voir qu'elle ou que lui"
                : selectionOnlyWaiting
                  ? "S'appliquera à la prochaine sélection ; cliquez pour revenir aux tournées de la frise"
                  : selectionOnly
                    ? "Revenir aux tournées de la frise"
                    : "N'afficher que la course ou le véhicule sélectionné"
            }
            className={cn(MAP_BUTTON, selectionOnly && "border-brand-300 bg-brand-50 text-brand-900 hover:bg-brand-50")}
          >
            <Focus aria-hidden className="size-3.5" />
            Sélection seule
          </button>
        </div>
        {usingFallback ? (
          <p className="rounded bg-white/90 px-1.5 py-0.5 text-[11px] text-slate-600">Fond de carte OpenStreetMap</p>
        ) : null}
      </div>
      <MapLegend planned={planned} />
      {!ready ? (
        <div className="absolute inset-0 grid place-items-center rounded-lg bg-slate-50 px-6 text-center text-sm text-slate-500">
          {webglAvailable
            ? "Chargement de la carte…"
            : "Carte indisponible : ce navigateur n'affiche pas les cartes (accélération graphique désactivée). La frise et les listes restent utilisables."}
        </div>
      ) : null}
    </div>
  );
}

const MAP_BUTTON =
  "inline-flex min-h-6 items-center gap-1.5 rounded-md border border-slate-300 bg-white/95 px-2 py-1 text-xs font-medium text-slate-700 shadow-xs hover:bg-white focus-visible:outline-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-50";

/** The marker of a stop in the legend (the map's own shapes, at their size). */
function StopSwatch({ shape, hollow = false }: { shape: StopShapeType; hollow?: boolean }) {
  const fill = hollow ? "#ffffff" : "#475569";
  const stroke = hollow ? "#475569" : "#ffffff";
  return (
    <svg viewBox="0 0 16 16" className="size-4 drop-shadow-[0_0_0.5px_rgb(15_23_42)]">
      {shape === "TAXI" ? <circle cx="8" cy="8" r="6.5" fill={fill} stroke={stroke} strokeWidth="2" /> : null}
      {shape === "VSL" ? <rect x="2" y="2" width="12" height="12" fill={fill} stroke={stroke} strokeWidth="2" /> : null}
      {shape === "AMBULANCE" ? (
        <path d="M5.5 1h5v4.5H15v5h-4.5V15h-5v-4.5H1v-5h4.5Z" fill={fill} stroke={stroke} strokeWidth="1.6" strokeLinejoin="miter" />
      ) : null}
    </svg>
  );
}

/** Key to the map's symbols, folded into a button at the bottom left (the map is small beside the timeline). */
function MapLegend({ planned }: { planned: boolean }) {
  const [open, setOpen] = useState(false);
  const item = "flex items-center gap-2";
  const swatch = "inline-flex w-6 shrink-0 items-center justify-center";
  return (
    <div className="absolute bottom-2 left-2 z-10 flex flex-col items-start gap-1">
      {open ? (
        <ul
          id="planning-map-legend"
          aria-label="Légende de la carte"
          className="max-h-56 w-64 space-y-1 overflow-y-auto rounded-md border border-slate-200 bg-white/95 p-2 text-xs text-slate-700 shadow-md"
        >
          <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {(["TAXI", "VSL", "AMBULANCE"] as const).map((type) => (
              <span key={type} className="inline-flex items-center gap-1">
                <span aria-hidden className="inline-flex">
                  <StopSwatch shape={type} />
                </span>
                {VEHICLE_TYPE_SHORT[type]}
              </span>
            ))}
          </li>
          <li className={item}>
            <span aria-hidden className={swatch}>
              <StopSwatch shape="TAXI" />
            </span>
            Prise en charge : pleine, couleur du véhicule
          </li>
          <li className={item}>
            <span aria-hidden className={swatch}>
              <StopSwatch shape="TAXI" hollow />
            </span>
            Dépose : creuse
          </li>
          <li className={item}>
            <span aria-hidden className={swatch}>
              <span className="h-[3px] w-6 rounded-full bg-blue-600" />
            </span>
            Tournée (à vol d&apos;oiseau)
          </li>
          <li className={item}>
            <span aria-hidden className={swatch}>
              <span className="size-3.5 rounded-full border-[2.5px] border-white bg-slate-900 ring-1 ring-slate-300" />
            </span>
            Dépôt
          </li>
          {planned ? (
            <li className={item}>
              <span aria-hidden className={cn(swatch, "gap-0.5")}>
                <span className="size-2 rotate-45 border border-slate-900" style={{ background: UNASSIGNED_COLOR }} />
                <span className="h-0 w-2 border-t-2 border-dashed" style={{ borderColor: UNASSIGNED_COLOR }} />
              </span>
              À placer : prise en charge → dépose (losanges)
            </li>
          ) : (
            <li className={item}>
              <span aria-hidden className={swatch}>
                <span className="size-3 rounded-full border-2 border-slate-600 bg-white" />
              </span>
              Course à planifier (prise en charge)
            </li>
          )}
          <li className={item}>
            <span aria-hidden className={swatch}>
              <svg viewBox="0 0 18 18" className="size-4">
                <path d="M9 1 17 16H1Z" fill="#fbbf24" stroke="#0f172a" strokeWidth="1.5" strokeLinejoin="round" />
                <path d="M9 6.5v4.5M9 13v.5" stroke="#0f172a" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </span>
            Course en violation
          </li>
          <li className={item}>
            <span aria-hidden className={swatch}>
              <span className="size-4 rounded-full border-[3px] border-slate-900" />
            </span>
            Course sélectionnée (trait : prise en charge → dépose)
          </li>
          <li className="pt-0.5 text-slate-500">Une couleur par véhicule, la même que dans la frise ; la forme dit son type.</li>
        </ul>
      ) : null}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? "planning-map-legend" : undefined}
        onClick={() => setOpen((v) => !v)}
        className={MAP_BUTTON}
      >
        <MapIcon aria-hidden className="size-3.5" />
        Légende
      </button>
    </div>
  );
}

export default PlanningMap;
