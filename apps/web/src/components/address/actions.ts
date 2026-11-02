"use server";

import { requireUser } from "@/lib/auth";
import { geocodeAddress, geocoderEnabled } from "@/lib/geocode";
import { geocodeQuerySchema } from "./address-schema";
import type { GeocodeOutcome } from "./address-utils";

/**
 * Looks up an address in the national address base. The client sends the
 * address text only (street, postal code, city) — never the person's name.
 */
export async function geocodeAddressAction(query: unknown): Promise<GeocodeOutcome> {
  await requireUser("REGULATOR");

  const parsed = geocodeQuerySchema.safeParse(query);
  if (!parsed.success) {
    return { status: "invalid", message: parsed.error.issues[0]?.message ?? "Adresse invalide." };
  }
  if (!geocoderEnabled()) return { status: "disabled" };

  try {
    const results = await geocodeAddress(parsed.data, 5);
    return {
      status: "ok",
      results: results.slice(0, 5).map((r) => ({
        label: r.label,
        address: r.address,
        postalCode: r.postalCode,
        city: r.city,
        lat: r.lat,
        lng: r.lng,
        score: r.score,
      })),
    };
  } catch {
    return {
      status: "error",
      message: "Le service de géocodage ne répond pas.",
    };
  }
}
