/**
 * French typography of the interface (lot UI-07): a no-break space before « : » and between a
 * number and its unit (« 45 min », « 152 km », « 12,50 € »); a narrow no-break space before
 * « ; ! ? » and inside « ». Without them a « : », a « » » or a unit can start a line in a
 * narrow cell or on a phone.
 *
 * `frenchSpacing` fixes a text written with ordinary spaces (texts built at run time from
 * stored values); `typographyIssues` finds them in a source text (the test that keeps the
 * screens right, typography.test.ts). Intl.NumberFormat already gives the right spaces in
 * numbers and amounts. Pure module.
 */

export const NBSP = " ";
export const NNBSP = " ";

/** Units written after a number on the screens. */
const UNITS = "min|km|h|€|%|kWh|L|s";

const SPACE_BEFORE_COLON = /(?<=\S) :(?=\s|$|["'`)])/g;
const SPACE_BEFORE_MARK = /(?<=\S) ([;!?])(?=\s|$|["'`)])/g;
const AFTER_OPENING_QUOTE = /« /g;
const BEFORE_CLOSING_QUOTE = / »/g;
const NUMBER_UNIT = new RegExp(`(\\d) (${UNITS})(?![\\p{L}\\p{N}'’])`, "gu");

/** The text with French spacing (idempotent). */
export function frenchSpacing(text: string): string {
  return text
    .replace(SPACE_BEFORE_COLON, `${NBSP}:`)
    .replace(SPACE_BEFORE_MARK, `${NNBSP}$1`)
    .replace(AFTER_OPENING_QUOTE, `«${NNBSP}`)
    .replace(BEFORE_CLOSING_QUOTE, `${NNBSP}»`)
    .replace(NUMBER_UNIT, `$1${NBSP}$2`);
}

export type TypographyIssue = { kind: "colon" | "mark" | "quote" | "unit"; excerpt: string };

const LEADING_COLON = /^ :(?=\s|$)/g;
const LEADING_MARK = /^ [;!?](?=\s|$)/g;
const LEADING_UNIT = new RegExp(`^ (${UNITS})(?![\\p{L}\\p{N}'’])`, "gu");

/**
 * What frenchSpacing would change in a text shown to users, with a short excerpt of each.
 * `continuation`: the text follows something else (a template part after an expression, a join
 * separator such as " ; "), so a leading « : », « ; » or unit counts too.
 */
export function typographyIssues(text: string, { continuation = false }: { continuation?: boolean } = {}): TypographyIssue[] {
  const issues: TypographyIssue[] = [];
  if (continuation) {
    for (const [pattern, kind] of [
      [LEADING_COLON, "colon"],
      [LEADING_MARK, "mark"],
      [LEADING_UNIT, "unit"],
    ] as const) {
      if (new RegExp(pattern.source, pattern.flags).test(text)) issues.push({ kind, excerpt: text.slice(0, 24) });
    }
  }
  const excerpt = (index: number) => text.slice(Math.max(0, index - 20), index + 12);
  for (const [pattern, kind] of [
    [SPACE_BEFORE_COLON, "colon"],
    [SPACE_BEFORE_MARK, "mark"],
    [AFTER_OPENING_QUOTE, "quote"],
    [BEFORE_CLOSING_QUOTE, "quote"],
    [NUMBER_UNIT, "unit"],
  ] as const) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) issues.push({ kind, excerpt: excerpt(match.index ?? 0) });
  }
  return issues;
}
