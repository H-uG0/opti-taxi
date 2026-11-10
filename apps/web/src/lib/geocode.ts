/**
 * Address geocoding through the French national address base (BAN), served by
 * the IGN Géoplateforme. Only the typed address is sent — never a patient name.
 * Disabled when GEOCODER_URL is empty: coordinates are then typed by hand.
 *
 * The answer comes from outside, so it is treated as untrusted: no redirect is
 * followed, the body is size-bounded, and it is parsed with zod, keeping only
 * well-formed features located in metropolitan France. Searches are throttled
 * per user (allowGeocodeSearch).
 *
 * Called by server actions only. No server-only import (it holds no secret and
 * no database access) so that the tests can import it.
 */
import { z } from "zod";
import { GEOCODE_QUERY_MAX, LAT_RANGE, LNG_RANGE } from "@/components/address/address-utils";

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

/** Most features read from one answer (and most requested). */
export const GEOCODE_MAX_FEATURES = 10;
/** Longest text kept from a feature (a BAN label is well under 100 characters). */
export const GEOCODE_TEXT_MAX = 300;
/** Largest answer read: ten features take a few kilobytes. */
export const GEOCODE_MAX_BODY_BYTES = 256 * 1024;
const GEOCODE_TIMEOUT_MS = 5000;

/** Inside the coordinates accepted for an address (metropolitan France, Corsica included). */
export function isInMetropolitanFrance(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= LAT_RANGE.min &&
    lat <= LAT_RANGE.max &&
    lng >= LNG_RANGE.min &&
    lng <= LNG_RANGE.max
  );
}

const featureText = z.string().trim().max(GEOCODE_TEXT_MAX).optional();

/**
 * One BAN feature (GeoJSON). z.number() refuses NaN and infinities; the
 * metropolitan France ranges are checked after parsing, so that a well-formed
 * feature located elsewhere is counted (GeocodeAnswer.outsideFrance).
 */
const featureSchema = z.object({
  geometry: z.object({
    // GeoJSON order: longitude, latitude (an altitude may follow).
    coordinates: z.tuple([z.number(), z.number()]).rest(z.number()),
  }),
  properties: z.object({
    label: featureText,
    name: featureText,
    postcode: featureText,
    city: featureText,
    score: z.number().min(0).max(1).optional(),
  }),
});

const answerSchema = z.object({ features: z.array(z.unknown()) });

/** A parsed BAN answer. */
export type GeocodeAnswer = {
  /** Valid features located in metropolitan France, in the service's order. */
  results: GeocodeResult[];
  /** Well-formed features dropped because they lie outside metropolitan France (overseas, abroad, swapped). */
  outsideFrance: number;
};

/**
 * A BAN answer: the first GEOCODE_MAX_FEATURES features, invalid ones dropped
 * (bad shape, text too long, coordinates outside metropolitan France: those
 * are counted). Throws when the answer itself is not a feature collection.
 */
export function parseGeocodeFeatures(body: unknown, query: string): GeocodeAnswer {
  const answer = answerSchema.safeParse(body);
  if (!answer.success) throw new Error("Geocoder answer is not a feature collection");

  const results: GeocodeResult[] = [];
  let outsideFrance = 0;
  for (const raw of answer.data.features.slice(0, GEOCODE_MAX_FEATURES)) {
    const feature = featureSchema.safeParse(raw);
    if (!feature.success) continue;
    const [lng, lat] = feature.data.geometry.coordinates;
    if (!isInMetropolitanFrance(lat, lng)) {
      outsideFrance += 1;
      continue;
    }
    const p = feature.data.properties;
    results.push({
      label: p.label || query,
      address: p.name ?? "",
      postalCode: p.postcode ?? "",
      city: p.city ?? "",
      lat,
      lng,
      score: p.score ?? 0,
    });
  }
  return { results, outsideFrance };
}

export type BestMatch =
  | { status: "found"; result: GeocodeResult }
  /** The match lies overseas or abroad: the address must be made more precise. */
  | { status: "outside_france" }
  /** No match, or one too uncertain to store without checking it by hand. */
  | { status: "not_found" };

/**
 * The match of an answer that may be stored as a point without a human check:
 * its first result, scored at least `minScore`. Its coordinates are checked
 * again against the metropolitan France ranges (defence in depth: the point
 * goes to the optimizer); with no result left, a match dropped for lying
 * outside them is reported as such rather than as "not found".
 */
export function bestMatch(answer: GeocodeAnswer, minScore: number): BestMatch {
  const [best] = answer.results;
  if (!best) return answer.outsideFrance > 0 ? { status: "outside_france" } : { status: "not_found" };
  if (!isInMetropolitanFrance(best.lat, best.lng)) return { status: "outside_france" };
  if (best.score < minScore) return { status: "not_found" };
  return { status: "found", result: best };
}

/** Results of a BAN answer (see parseGeocodeFeatures). */
export function parseGeocodeAnswer(body: unknown, query: string): GeocodeResult[] {
  return parseGeocodeFeatures(body, query).results;
}

/**
 * Body of `response` as text, refused beyond `maxBytes`: on the declared
 * length first, then on the bytes actually read (the header may be missing,
 * or lie).
 */
export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Geocoder answer too large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Geocoder answer too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export function geocoderEnabled(): boolean {
  return Boolean(process.env.GEOCODER_URL);
}

/** Searches an address: the matches in metropolitan France. */
export async function geocodeAddress(query: string, limit = 5): Promise<GeocodeResult[]> {
  return (await searchAddress(query, limit)).results;
}

/**
 * Searches an address, also counting the matches dropped because they lie
 * outside metropolitan France (to tell "not found" from "found elsewhere").
 */
export async function searchAddress(query: string, limit = 5): Promise<GeocodeAnswer> {
  const base = process.env.GEOCODER_URL;
  const q = query.trim();
  if (!base || q.length < 3) return { results: [], outsideFrance: 0 };

  const url = new URL(base);
  url.searchParams.set("q", q.slice(0, GEOCODE_QUERY_MAX));
  url.searchParams.set("limit", String(Math.min(Math.max(Math.trunc(limit) || 1, 1), GEOCODE_MAX_FEATURES)));

  // The timeout also covers reading the body. A redirect is an error: the
  // configured service answers itself, the address is never sent elsewhere.
  const response = await fetch(url, { signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS), cache: "no-store", redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Geocoder HTTP ${response.status}`);
  }
  const text = await readBoundedText(response, GEOCODE_MAX_BODY_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("Geocoder answer is not JSON");
  }
  return parseGeocodeFeatures(body, q);
}

// ---------------------------------------------------------------------------
// Per-user throttle

export type ThrottleOptions = {
  /** Searches given back per second. */
  perSecond: number;
  /** Searches allowed at once (bucket size). */
  burst: number;
};

export type TokenBucket = { tokens: number; at: number };

/**
 * One step of a token bucket (pure): refills the bucket for the time elapsed
 * since its last use, then takes one token if there is a whole one. A fresh
 * key starts full; a clock going backwards refills nothing.
 */
export function takeToken(
  bucket: TokenBucket | undefined,
  now: number,
  options: ThrottleOptions,
): { allowed: boolean; bucket: TokenBucket } {
  const tokens = bucket
    ? Math.min(options.burst, bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * options.perSecond)
    : options.burst;
  return tokens >= 1 ? { allowed: true, bucket: { tokens: tokens - 1, at: now } } : { allowed: false, bucket: { tokens, at: now } };
}

/**
 * Token buckets by key, in memory. Beyond `maxKeys` keys the least recently
 * used one is forgotten (it starts full again on its next use).
 */
export function createThrottle(
  options: ThrottleOptions & { maxKeys?: number },
  buckets: Map<string, TokenBucket> = new Map(),
): (key: string, now?: number) => boolean {
  const maxKeys = options.maxKeys ?? 1000;
  return (key, now = Date.now()) => {
    const step = takeToken(buckets.get(key), now, options);
    // Re-inserted so that the map's order is the order of last use.
    buckets.delete(key);
    buckets.set(key, step.bucket);
    if (buckets.size > maxKeys) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    return step.allowed;
  };
}

/** 5 searches per second and per user, 10 at once. */
export const GEOCODE_THROTTLE: ThrottleOptions = { perSecond: 5, burst: 10 };

export const GEOCODE_THROTTLED_MESSAGE =
  "Trop de recherches d'adresse en peu de temps\u00a0: patientez quelques secondes puis réessayez.";

// One set of buckets for the whole server process, even when this module is
// evaluated more than once (development reloads, several server bundles).
const globalForGeocode = globalThis as unknown as { geocodeBuckets?: Map<string, TokenBucket> };
const geocodeThrottle = createThrottle(GEOCODE_THROTTLE, (globalForGeocode.geocodeBuckets ??= new Map()));

/**
 * Takes one geocoding search from the user's allowance: false when it is used
 * up (answer GEOCODE_THROTTLED_MESSAGE). Call it before each geocodeAddress
 * made for a user. In memory: each server process has its own allowance.
 */
export function allowGeocodeSearch(userId: string): boolean {
  return geocodeThrottle(userId);
}
