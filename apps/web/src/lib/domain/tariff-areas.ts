/**
 * Tariff areas (TariffArea): the communes of the taxi « Grande ville » fare
 * and of the ambulance agglomeration fare. A trip's communes come from its
 * address snapshot ("12 rue X, 13005 Marseille", rules.formatAddress), so a
 * trip keeps the fare of the address it was created with. Pure module.
 */
import type { TariffArea, TariffAreaKind, TariffAreaRule } from "@prisma/client";
import { toIsoDate } from "@/lib/time";

/** A place as the tariff areas read it: its commune and, when known, its postal code. */
export type Commune = { city: string; postalCode: string | null };

export type AreaInput = Pick<TariffArea, "kind" | "name" | "department" | "communes" | "rule" | "hubCommune" | "validFrom" | "validTo">;

export const AREA_KIND_LABELS: Record<TariffAreaKind, string> = {
  BIG_CITY: "Grande ville (taxi)",
  AGGLOMERATION: "Agglomération (ambulance)",
};

export const AREA_RULE_LABELS: Record<TariffAreaRule, string> = {
  ANY_END: "Prise en charge ou dépose dans la zone",
  BOTH_INSIDE: "Trajet entièrement dans la zone",
  TO_HUB: "Entre une commune de la zone et la commune centre",
};

/** "Saint-Martin-d'Hères" and "ST MARTIN D HERES" alike; "Marseille 5e Arrondissement" is Marseille. */
export function normalizeCommune(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\b(\d{1,2})\s*(e|er|eme)?(\s+arrondissement)?$/, "")
    .replace(/\barrondissement$/, "")
    .replace(/\bste\b/g, "sainte")
    .replace(/\bst\b/g, "saint")
    .replace(/\s+/g, " ")
    .trim();
}

/** Commune of a formatted address ("…, 13005 Marseille"), or null when it has no postal code. */
export function communeOfAddress(address: string): Commune | null {
  const match = /(?:^|[\s,])(\d{5})\s+([^,\d][^,]*)$/.exec(address.trim());
  if (!match) return null;
  return { postalCode: match[1]!, city: match[2]!.trim() };
}

/** Department of a postal code ("13005" -> "13"; Corsica stays "20"). */
function departmentOf(postalCode: string | null): string | null {
  return postalCode && /^\d{5}$/.test(postalCode) ? postalCode.slice(0, 2) : null;
}

function inForce(area: Pick<AreaInput, "validFrom" | "validTo">, isoDate: string): boolean {
  if (area.validFrom && toIsoDate(area.validFrom) > isoDate) return false;
  return !(area.validTo && toIsoDate(area.validTo) < isoDate);
}

/** The areas valid on isoDate (no start or end date: always). */
export function areasInForce<A extends Pick<AreaInput, "validFrom" | "validTo">>(areas: readonly A[], isoDate: string): A[] {
  return areas.filter((area) => inForce(area, isoDate));
}

/** "Châteaurenard (13)": a commune of another department than the area's. */
function splitDepartment(entry: string): { name: string; department: string | null } {
  const match = /^(.*?)\s*\((\d{2}|2A|2B)\)\s*$/i.exec(entry);
  return match ? { name: match[1]!, department: match[2]!.toUpperCase() } : { name: entry, department: null };
}

function sameCommune(area: Pick<AreaInput, "department">, entry: string, place: Commune): boolean {
  const { name, department: own } = splitDepartment(entry);
  if (normalizeCommune(name) !== normalizeCommune(place.city)) return false;
  const department = departmentOf(place.postalCode);
  const expected = own ?? area.department;
  return department === null || expected === "*" || department === expected;
}

/** Is `place` one of the area's communes (or its centre commune)? */
export function inArea(area: Pick<AreaInput, "communes" | "hubCommune" | "department">, place: Commune | null): boolean {
  if (!place) return false;
  const names = area.hubCommune ? [...area.communes, area.hubCommune] : area.communes;
  return names.some((name) => sameCommune(area, name, place));
}

/** Does a trip from `pickup` to `dropoff` fall under the area's rule? */
export function tripInArea(area: AreaInput, pickup: Commune | null, dropoff: Commune | null): boolean {
  switch (area.rule) {
    case "ANY_END":
      return inArea(area, pickup) || inArea(area, dropoff);
    case "BOTH_INSIDE":
      return inArea(area, pickup) && inArea(area, dropoff);
    case "TO_HUB": {
      if (!area.hubCommune) return false;
      const hub = { communes: [area.hubCommune], hubCommune: null, department: area.department };
      return (inArea(hub, pickup) && inArea(area, dropoff)) || (inArea(hub, dropoff) && inArea(area, pickup));
    }
  }
}

export type TripAreaFlags = { bigCity: boolean; agglomeration: boolean };

/**
 * Contract flags of a trip (`trips[].bigCity`, `trips[].agglomeration`):
 * a « Grande ville » area of the trip; an agglomeration area that holds the
 * company's head office (ambulance fare of the companies based there) and
 * the trip.
 */
export function tripAreaFlags(
  areas: readonly AreaInput[],
  pickup: Commune | null,
  dropoff: Commune | null,
  headOffice: Commune | null,
): TripAreaFlags {
  return {
    bigCity: areas.some((area) => area.kind === "BIG_CITY" && tripInArea(area, pickup, dropoff)),
    agglomeration:
      headOffice !== null &&
      areas.some((area) => area.kind === "AGGLOMERATION" && inArea(area, headOffice) && tripInArea(area, pickup, dropoff)),
  };
}

/** "Marseille, Allauch, Plan-de-Cuques" from a textarea (one per line, or separated by commas or semicolons). */
export function parseCommuneList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\n,;]+/)) {
    const name = raw.trim().replace(/\s+/g, " ");
    if (!name || seen.has(normalizeCommune(name))) continue;
    seen.add(normalizeCommune(name));
    out.push(name);
  }
  return out;
}
