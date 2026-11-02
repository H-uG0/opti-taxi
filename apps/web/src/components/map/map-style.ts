import type { StyleSpecification } from "maplibre-gl";

/**
 * Raster OpenStreetMap style: needs no API key and no glyphs, used when
 * NEXT_PUBLIC_MAP_STYLE_URL is empty or fails to load.
 */
export const OSM_RASTER_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

/** Vector style URL from the environment (inlined at build time), or null. */
export function configuredStyleUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_MAP_STYLE_URL?.trim();
  return url ? url : null;
}

/** Marseille – Grenoble axis, shown before the data is fitted. */
export const AXIS_CENTER: [number, number] = [5.75, 44.3];
export const AXIS_ZOOM = 7;
