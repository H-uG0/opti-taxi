import "server-only";

/**
 * Address geocoding through the French national address base (BAN), served by
 * the IGN Géoplateforme. Only the typed address is sent — never a patient name.
 * Disabled when GEOCODER_URL is empty: coordinates are then typed by hand.
 */

export type GeocodeResult = {
  label: string;
  address: string;
  postalCode: string;
  city: string;
  lat: number;
  lng: number;
  /** BAN confidence, 0..1. Below ~0.5 the match should be checked by hand. */
  score: number;
};

type BanFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    label?: string;
    name?: string;
    postcode?: string;
    city?: string;
    score?: number;
  };
};

export function geocoderEnabled(): boolean {
  return Boolean(process.env.GEOCODER_URL);
}

export async function geocodeAddress(query: string, limit = 5): Promise<GeocodeResult[]> {
  const base = process.env.GEOCODER_URL;
  const q = query.trim();
  if (!base || q.length < 3) return [];

  const url = new URL(base);
  url.searchParams.set("q", q.slice(0, 200));
  url.searchParams.set("limit", String(limit));

  const response = await fetch(url, { signal: AbortSignal.timeout(5000), cache: "no-store" });
  if (!response.ok) throw new Error(`Geocoder HTTP ${response.status}`);
  const body = (await response.json()) as { features?: BanFeature[] };

  return (body.features ?? []).flatMap((feature) => {
    const coords = feature.geometry?.coordinates;
    const p = feature.properties;
    if (!coords || !p) return [];
    return [
      {
        label: p.label ?? q,
        address: p.name ?? "",
        postalCode: p.postcode ?? "",
        city: p.city ?? "",
        lng: coords[0],
        lat: coords[1],
        score: p.score ?? 0,
      },
    ];
  });
}
