/**
 * The one way to write a person's name on the regulator screens: « DUPONT Marie »,
 * surname first in capitals (lists, choices, planning, courses, équipages: sorted and
 * searched by surname), « DUPONT M. » in a narrow cell. The driver app keeps its own
 * spoken order (« Marie DUPONT », app/chauffeur/_lib/roadmap.ts).
 */
export type PersonNameParts = { firstName: string; lastName: string };

export function formatPersonName(person: PersonNameParts, form: "list" | "short" = "list"): string {
  const last = person.lastName.trim().toLocaleUpperCase("fr-FR");
  const first = person.firstName.trim();
  if (form === "short") {
    const initial = Array.from(first)[0];
    return initial ? `${last} ${initial.toLocaleUpperCase("fr-FR")}.` : last;
  }
  return `${last} ${first}`.trim();
}
