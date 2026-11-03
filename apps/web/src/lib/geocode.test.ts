import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bestMatch,
  createThrottle,
  GEOCODE_MAX_BODY_BYTES,
  GEOCODE_MAX_FEATURES,
  GEOCODE_TEXT_MAX,
  geocodeAddress,
  isInMetropolitanFrance,
  parseGeocodeAnswer,
  parseGeocodeFeatures,
  readBoundedText,
  searchAddress,
  takeToken,
  type TokenBucket,
} from "./geocode";

/** A BAN feature (GeoJSON: longitude first). */
function feature(lng: unknown, lat: unknown, properties: Record<string, unknown> = {}) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: {
      label: "3 Rue Paradis 13001 Marseille",
      name: "3 Rue Paradis",
      postcode: "13001",
      city: "Marseille",
      score: 0.93,
      ...properties,
    },
  };
}

describe("isInMetropolitanFrance", () => {
  it("accepts mainland France and Corsica, refuses swapped or foreign coordinates", () => {
    expect(isInMetropolitanFrance(43.2965, 5.3698)).toBe(true); // Marseille
    expect(isInMetropolitanFrance(41.9192, 8.7386)).toBe(true); // Ajaccio
    expect(isInMetropolitanFrance(5.3698, 43.2965)).toBe(false); // swapped
    expect(isInMetropolitanFrance(16.2412, -61.5331)).toBe(false); // Guadeloupe
    expect(isInMetropolitanFrance(Number.NaN, 5)).toBe(false);
    expect(isInMetropolitanFrance(Number.POSITIVE_INFINITY, 5)).toBe(false);
  });
});

describe("parseGeocodeAnswer", () => {
  it("maps a BAN feature, longitude first", () => {
    expect(parseGeocodeAnswer({ type: "FeatureCollection", features: [feature(5.3698, 43.2965)] }, "3 rue paradis")).toEqual([
      {
        label: "3 Rue Paradis 13001 Marseille",
        address: "3 Rue Paradis",
        postalCode: "13001",
        city: "Marseille",
        lat: 43.2965,
        lng: 5.3698,
        score: 0.93,
      },
    ]);
  });

  it("keeps a feature without optional properties, labelled with the query", () => {
    const bare = { geometry: { coordinates: [5.37, 43.29, 12] }, properties: {} };
    expect(parseGeocodeAnswer({ features: [bare] }, "rue paradis")).toEqual([
      { label: "rue paradis", address: "", postalCode: "", city: "", lat: 43.29, lng: 5.37, score: 0 },
    ]);
  });

  it("drops invalid features and keeps the valid ones in order", () => {
    const answer = {
      features: [
        feature(43.2965, 5.3698), // swapped
        feature(-61.53, 16.24), // overseas
        feature("5.37", 43.29), // not a number
        { geometry: { coordinates: [5.37] }, properties: {} }, // missing latitude
        { geometry: null, properties: {} },
        "not a feature",
        feature(5.37, 43.29, { label: "x".repeat(GEOCODE_TEXT_MAX + 1) }),
        feature(5.37, 43.29, { score: 7 }),
        feature(5.37, 43.29, { city: 13001 }),
        feature(5.72, 45.19, { city: "Grenoble" }),
      ],
    };
    expect(parseGeocodeAnswer(answer, "q").map((r) => r.city)).toEqual(["Grenoble"]);
  });

  it("reads at most GEOCODE_MAX_FEATURES features", () => {
    const features = Array.from({ length: GEOCODE_MAX_FEATURES + 5 }, (_, i) => feature(5, 43 + i / 100));
    expect(parseGeocodeAnswer({ features }, "q")).toHaveLength(GEOCODE_MAX_FEATURES);
  });

  it("throws on an answer that is not a feature collection", () => {
    expect(() => parseGeocodeAnswer(null, "q")).toThrow();
    expect(() => parseGeocodeAnswer({ features: "none" }, "q")).toThrow();
    expect(() => parseGeocodeAnswer([], "q")).toThrow();
  });
});

describe("parseGeocodeFeatures", () => {
  it("counts the well-formed features dropped for lying outside metropolitan France", () => {
    const answer = {
      features: [
        feature(-61.53, 16.24), // Guadeloupe
        feature(43.2965, 5.3698), // swapped
        feature("5.37", 43.29), // malformed: not counted
        feature(5.72, 45.19, { city: "Grenoble" }),
      ],
    };
    const parsed = parseGeocodeFeatures(answer, "q");
    expect(parsed.outsideFrance).toBe(2);
    expect(parsed.results.map((r) => r.city)).toEqual(["Grenoble"]);
  });

  it("only counts among the features read", () => {
    const features = [...Array.from({ length: GEOCODE_MAX_FEATURES }, () => feature(5.37, 43.29)), feature(-61.53, 16.24)];
    expect(parseGeocodeFeatures({ features }, "q")).toMatchObject({ outsideFrance: 0 });
  });
});

describe("bestMatch", () => {
  const marseille = { label: "Marseille", address: "", postalCode: "13001", city: "Marseille", lat: 43.29, lng: 5.37, score: 0.9 };

  it("keeps the first result when it is certain enough", () => {
    expect(bestMatch({ results: [marseille], outsideFrance: 0 }, 0.5)).toEqual({ status: "found", result: marseille });
    expect(bestMatch({ results: [marseille], outsideFrance: 3 }, 0.5)).toEqual({ status: "found", result: marseille });
  });

  it("refuses an uncertain match or no match", () => {
    expect(bestMatch({ results: [{ ...marseille, score: 0.3 }], outsideFrance: 0 }, 0.5)).toEqual({ status: "not_found" });
    expect(bestMatch({ results: [], outsideFrance: 0 }, 0.5)).toEqual({ status: "not_found" });
  });

  it("says when the match lies outside metropolitan France", () => {
    expect(bestMatch({ results: [], outsideFrance: 1 }, 0.5)).toEqual({ status: "outside_france" });
    // Checked again whatever the parser kept.
    expect(bestMatch({ results: [{ ...marseille, lat: 16.24, lng: -61.53 }], outsideFrance: 0 }, 0.5)).toEqual({
      status: "outside_france",
    });
  });
});

describe("readBoundedText", () => {
  it("reads a body within the limit", async () => {
    await expect(readBoundedText(new Response("é".repeat(10)), 100)).resolves.toBe("é".repeat(10));
  });

  it("refuses a declared length over the limit without reading", async () => {
    const response = new Response("{}", { headers: { "content-length": String(GEOCODE_MAX_BODY_BYTES + 1) } });
    await expect(readBoundedText(response, GEOCODE_MAX_BODY_BYTES)).rejects.toThrow(/too large/);
  });

  it("refuses a body over the limit even when the header is missing or lies", async () => {
    const big = "x".repeat(2048);
    await expect(readBoundedText(new Response(big), 1024)).rejects.toThrow(/too large/);
    await expect(readBoundedText(new Response(big, { headers: { "content-length": "10" } }), 1024)).rejects.toThrow(/too large/);
  });

  it("counts bytes, not characters", async () => {
    // "é" is 2 bytes in UTF-8: 600 characters are 1200 bytes.
    await expect(readBoundedText(new Response("é".repeat(600)), 1024)).rejects.toThrow(/too large/);
  });
});

describe("geocodeAddress", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function stubFetch(response: Response) {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("does not call the service when it is not configured or the query is too short", async () => {
    vi.stubEnv("GEOCODER_URL", "");
    const fetchMock = stubFetch(new Response("{}"));
    await expect(geocodeAddress("3 rue Paradis Marseille")).resolves.toEqual([]);
    vi.stubEnv("GEOCODER_URL", "https://geocoder.test/search");
    await expect(geocodeAddress("  ab ")).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses redirects, bounds the limit and parses the answer", async () => {
    vi.stubEnv("GEOCODER_URL", "https://geocoder.test/search");
    const fetchMock = stubFetch(new Response(JSON.stringify({ features: [feature(5.3698, 43.2965), feature(43.2965, 5.3698)] })));

    const results = await geocodeAddress(" 3 rue Paradis Marseille ", 50);
    expect(results.map((r) => [r.lat, r.lng])).toEqual([[43.2965, 5.3698]]);
    // A fresh body: the first one was consumed.
    stubFetch(new Response(JSON.stringify({ features: [feature(5.3698, 43.2965), feature(43.2965, 5.3698)] })));
    await expect(searchAddress("3 rue Paradis Marseille")).resolves.toMatchObject({ outsideFrance: 1 });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.get("q")).toBe("3 rue Paradis Marseille");
    expect(url.searchParams.get("limit")).toBe(String(GEOCODE_MAX_FEATURES));
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws on an HTTP error, a non-JSON body or an oversized body", async () => {
    vi.stubEnv("GEOCODER_URL", "https://geocoder.test/search");
    stubFetch(new Response("busy", { status: 503 }));
    await expect(geocodeAddress("3 rue Paradis")).rejects.toThrow(/HTTP 503/);
    stubFetch(new Response("<html>"));
    await expect(geocodeAddress("3 rue Paradis")).rejects.toThrow(/not JSON/);
    stubFetch(new Response(" ".repeat(GEOCODE_MAX_BODY_BYTES + 1)));
    await expect(geocodeAddress("3 rue Paradis")).rejects.toThrow(/too large/);
  });
});

describe("takeToken", () => {
  const options = { perSecond: 5, burst: 10 };

  it("starts full and takes one token", () => {
    expect(takeToken(undefined, 1000, options)).toEqual({ allowed: true, bucket: { tokens: 9, at: 1000 } });
  });

  it("refuses when less than a whole token is left", () => {
    expect(takeToken({ tokens: 0.5, at: 1000 }, 1000, options)).toEqual({ allowed: false, bucket: { tokens: 0.5, at: 1000 } });
  });

  it("refills with time, up to the burst", () => {
    // 100 ms at 5 per second give back half a token: 0.5 + 0.5 = 1, enough for one search.
    const step = takeToken({ tokens: 0.5, at: 1000 }, 1100, options);
    expect(step.allowed).toBe(true);
    expect(step.bucket.tokens).toBeCloseTo(0);
    expect(takeToken({ tokens: 0, at: 0 }, 60_000, options).bucket.tokens).toBe(9);
  });

  it("refills nothing when the clock goes backwards", () => {
    expect(takeToken({ tokens: 0, at: 5000 }, 1000, options)).toEqual({ allowed: false, bucket: { tokens: 0, at: 1000 } });
  });
});

describe("createThrottle", () => {
  it("allows a burst of 10, then 5 per second, per key", () => {
    const allow = createThrottle({ perSecond: 5, burst: 10 });
    const burst = Array.from({ length: 11 }, () => allow("u1", 0));
    expect(burst.filter(Boolean)).toHaveLength(10);
    expect(burst[10]).toBe(false);
    expect(allow("u2", 0)).toBe(true); // another user has their own allowance

    // One second later: 5 more searches, not 6.
    const later = Array.from({ length: 6 }, () => allow("u1", 1000));
    expect(later).toEqual([true, true, true, true, true, false]);
  });

  it("forgets the least recently used key beyond maxKeys", () => {
    const buckets = new Map<string, TokenBucket>();
    const allow = createThrottle({ perSecond: 1, burst: 1, maxKeys: 2 }, buckets);
    expect(allow("a", 0)).toBe(true);
    expect(allow("b", 0)).toBe(true);
    expect(allow("a", 0)).toBe(false); // "a" is now the most recently used
    expect(allow("c", 0)).toBe(true); // "b" is forgotten
    expect([...buckets.keys()]).toEqual(["a", "c"]);
    expect(allow("b", 0)).toBe(true); // starts full again
  });
});
