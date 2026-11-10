/**
 * Filters of the lists, kept in the URL (FilterBar, components/ui): reading a
 * parameter, building the address of a filtered list without its empty or
 * default values, searching without accents, and the pages of a long list.
 * Pure module (no React, no database), shared by the pages and their tests.
 */

export type SearchParamValue = string | string[] | undefined;
export type SearchParams = Readonly<Record<string, SearchParamValue>>;

/** The first value of a parameter, trimmed and capped ("" when absent). */
export function readParam(params: SearchParams | URLSearchParams, key: string, maxLength = 100): string {
  const raw = params instanceof URLSearchParams ? params.get(key) : params[key];
  const value = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  return value.trim().slice(0, maxLength);
}

/** The parameter when it is one of `allowed`, else null (an old or hand-typed URL never breaks the page). */
export function pickParam<T extends string>(params: SearchParams | URLSearchParams, key: string, allowed: readonly T[]): T | null {
  const value = readParam(params, key);
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/** An id-like parameter (cuid, uuid…), else null. */
export function idParam(params: SearchParams | URLSearchParams, key: string): string | null {
  const value = readParam(params, key);
  return /^[\w-]{1,64}$/.test(value) ? value : null;
}

/**
 * `path?a=1&b=2` with the parameters that hold a value, in the given order:
 * empty values, null and undefined are left out, so the address stays short
 * and « Réinitialiser » is the bare path.
 */
export function filterHref(path: string, params: Readonly<Record<string, string | number | null | undefined>>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

/**
 * The query string of a filter form: every named field with a value, minus
 * the fields still at their default (`defaults`: name → default value), in
 * the form's order. A field named twice (checkboxes) keeps every value.
 */
export function formQuery(entries: Iterable<[string, string]>, defaults: Readonly<Record<string, string>> = {}): string {
  const query = new URLSearchParams();
  for (const [key, raw] of entries) {
    const value = raw.trim();
    if (value === "" || defaults[key] === value) continue;
    query.append(key, value);
  }
  return query.toString();
}

/** Lowercase, accents and ligatures removed, spaces collapsed: « Hélène Œuvray » → « helene oeuvray ». */
export function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every word of `query` appears in one of the texts (accents and case aside). An empty query matches all. */
export function matchesWords(query: string, texts: readonly (string | null | undefined)[]): boolean {
  const words = normalizeSearch(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalizeSearch(texts.filter(Boolean).join(" "));
  return words.every((word) => haystack.includes(word));
}

/** Digits only, French national form: « +33 6 12 34 56 78 » (or « 33 6 12 34 56 78 ») → « 0612345678 ». */
export function phoneDigits(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (/^\s*(\+|00)33/.test(value) && digits.length > 2) return `0${digits.replace(/^(00)?33/, "")}`;
  // Eleven digits starting with 33: a French number in international form whose « + » was lost.
  if (digits.length === 11 && digits.startsWith("33")) return `0${digits.slice(2)}`;
  return digits;
}

/** A page of a long list: 1-based number, kept within the pages that exist. */
export function pageOf(params: SearchParams | URLSearchParams, total: number, pageSize: number): { page: number; pageCount: number; skip: number } {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const requested = Number.parseInt(readParam(params, "page", 6), 10);
  const page = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), pageCount) : 1;
  return { page, pageCount, skip: (page - 1) * pageSize };
}

/**
 * The page links to show: the first and last pages, the current one and its
 * neighbours, "…" in the gaps (1 … 4 5 6 … 20).
 */
export function pageItems(page: number, pageCount: number): (number | "…")[] {
  const shown = new Set([1, pageCount, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pageCount));
  // A gap of one page is shown as that page, not as "…".
  if (shown.has(3) && !shown.has(2)) shown.add(2);
  if (shown.has(pageCount - 2) && !shown.has(pageCount - 1)) shown.add(pageCount - 1);
  const sorted = [...shown].sort((a, b) => a - b);
  const items: (number | "…")[] = [];
  for (const [index, p] of sorted.entries()) {
    const previous = sorted[index - 1];
    if (previous !== undefined && p - previous > 1) items.push("…");
    items.push(p);
  }
  return items;
}
