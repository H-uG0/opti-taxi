/**
 * Invented identities: random first name x last name combinations, street
 * addresses and phone numbers taken from the ranges ARCEP reserves for fiction
 * (they are never assigned to a real subscriber).
 */
import { DEMO_EMAIL_DOMAIN } from "@/lib/demo";
import type { Rng } from "./random";

const PATIENT_FIRST_NAMES = [
  "Monique", "Gérard", "Josiane", "Bernard", "Colette", "Marcel", "Yvette", "Raymond",
  "Simone", "André", "Odette", "Henri", "Ginette", "Lucien", "Paulette", "Roger",
  "Denise", "Jacques", "Huguette", "Robert", "Micheline", "Pierre", "Jeannine", "Claude",
  "Arlette", "Maurice", "Christiane", "Gilbert", "Nicole", "René", "Fatima", "Mohamed",
  "Antoine", "Rosa", "Salvatore", "Josette", "Fernand", "Lucienne", "Alain", "Martine",
  "Daniel", "Sylvie", "Patrick", "Chantal", "Françoise", "Michel", "Jean-Pierre", "Marie-Thérèse",
  "Yamina", "Ahmed", "Giovanna", "Serge", "Éliane", "Gisèle",
] as const;

const PATIENT_LAST_NAMES = [
  "Abbadie", "Aubert", "Barthélémy", "Blanc", "Bonnefoy", "Castel", "Chauvet", "Coste",
  "Durand", "Espitalier", "Faure", "Gauthier", "Guigues", "Imbert", "Jullien", "Laugier",
  "Martin", "Maurel", "Meyer", "Nicolas", "Olivier", "Pellegrin", "Peyron", "Reboul",
  "Richaud", "Roman", "Sauvaire", "Silvestre", "Tardieu", "Turc", "Vial", "Bertrand",
  "Brémond", "Ferrand", "Gras", "Arnoux", "Mounier", "Allemand", "Truchet", "Hamidi",
  "Esposito", "Ruiz", "Lopez", "Benhamou", "Ollier", "Escoffier", "Chabrand", "Pascal",
] as const;

/**
 * More names for the large data sets (occasional patients, pnpm db:seed --fleet): appended to the lists
 * above only through NameFactory's `extended` option, so the small seed draws the same names as before.
 */
const EXTRA_PATIENT_FIRST_NAMES = [
  "Annie", "Bernadette", "Camille", "Dominique", "Évelyne", "Fabienne", "Gabriel", "Hélène",
  "Isabelle", "Jacqueline", "Karima", "Louis", "Madeleine", "Noël", "Olga", "Paul",
  "Régine", "Suzanne", "Thérèse", "Victor", "Yves", "Zohra", "Brigitte", "Émile",
  "Georgette", "Jeanne", "Léon", "Marthe", "Norbert", "Rachid", "Solange", "Thierry",
] as const;

const EXTRA_PATIENT_LAST_NAMES = [
  "Achard", "Baudoin", "Cauvin", "Dalmasso", "Estienne", "Fabre-Domergue", "Garcin", "Hugues",
  "Isnard", "Jourdan", "Lantelme", "Magnan", "Nègre", "Orsini", "Pons", "Queyras",
  "Raybaud", "Signoret", "Tassy", "Ughetto", "Vachier", "Barral", "Cotte", "Davin",
  "Eymard", "Fouque", "Giraudon", "Hermitte", "Juramy", "Long", "Mille", "Rostagni",
] as const;

/** First names of the generated staff (pnpm db:seed --fleet): distinct from the patients' lists. */
export const STAFF_FIRST_NAMES = [
  "Adrien", "Alexandre", "Amélie", "Anthony", "Audrey", "Aurélie", "Baptiste", "Benjamin",
  "Caroline", "Cédric", "Charlotte", "Clément", "Damien", "David", "Delphine", "Émilie",
  "Fabien", "Florian", "Guillaume", "Hélène", "Jérémy", "Jessica", "Jonathan", "Julie",
  "Laetitia", "Ludovic", "Manon", "Marion", "Maxime", "Mélanie", "Nicolas", "Océane",
  "Pauline", "Quentin", "Rémi", "Sandrine", "Sébastien", "Stéphanie", "Valentin", "Virginie",
  "Yannick", "Yasmine", "Samir", "Lina", "Karim", "Sonia", "Hugo", "Léa",
] as const;

export const STREETS = [
  "rue des Lilas", "avenue Jean Jaurès", "boulevard de la République", "chemin des Oliviers",
  "rue Victor Hugo", "allée des Pins", "impasse des Cigales", "rue Pasteur",
  "avenue des Tilleuls", "rue de la Fontaine", "chemin des Vignes", "rue des Écoles",
  "rue du Moulin", "avenue Frédéric Mistral", "rue des Amandiers", "traverse des Romarins",
  "chemin de la Colline", "rue des Jardins", "avenue de la Libération", "rue Jean Moulin",
  "allée des Mimosas", "rue du Lavoir", "chemin du Canal", "rue des Capucins",
  "montée des Genêts", "rue des Tanneurs", "avenue des Platanes", "rue des Chênes",
] as const;

const ACCESS_NOTES = [
  "Digicode 2B47, 3e étage avec ascenseur.",
  "Sonner chez la voisine du 1er étage si pas de réponse.",
  "Maison au fond de l'impasse, portail vert.",
  "Prévenir par téléphone 10 min avant l'arrivée.",
  "Malentendant : privilégier les SMS pour prévenir.",
  "Escalier étroit, prévoir un bras pour descendre.",
  "Résidence les Amandiers, bâtiment C, rez-de-chaussée.",
  "Chien dans le jardin, attendre au portail.",
  "Se garer sur le parking de la pharmacie en face.",
] as const;

/** Removes accents and anything that is not a letter, digit or hyphen: "Élodie" -> "elodie". */
export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Domain of every account the seed creates (.test is reserved, never delivered): see prisma/safety.ts.
 * The server refuses to start in production outside demo mode while one exists (lib/demo.ts).
 */
export const SEED_EMAIL_DOMAIN = DEMO_EMAIL_DOMAIN;

/** prenom.nom@opti-taxi.test, ASCII and lowercase. */
export function devEmail(firstName: string, lastName: string): string {
  return `${slugify(firstName)}.${slugify(lastName)}${SEED_EMAIL_DOMAIN}`;
}

function pairs(rng: Rng, count: number): string {
  return Array.from({ length: count }, () => String(rng.int(0, 99)).padStart(2, "0")).join(" ");
}

/** Landline in the 04 65 71 xx xx range reserved for fiction. */
export function fictitiousLandline(rng: Rng): string {
  return `04 65 71 ${pairs(rng, 2)}`;
}

/** Mobile in the 06 39 98 xx xx range reserved for fiction. */
export function fictitiousMobile(rng: Rng): string {
  return `06 39 98 ${pairs(rng, 2)}`;
}

export function streetAddress(rng: Rng): string {
  const number = rng.int(1, 140);
  const suffix = rng.chance(0.08) ? " bis" : "";
  return `${number}${suffix} ${rng.pick(STREETS)}`;
}

export function randomAccessNote(rng: Rng): string {
  return rng.pick(ACCESS_NOTES);
}

export type NameLists = {
  /** Patient lists plus the extra names (larger data sets). */
  extended?: boolean;
  /** First names to draw from instead of the patients' (staff). */
  firstNames?: readonly string[];
};

/** Hands out unique invented first name / last name pairs. */
export class NameFactory {
  private readonly used = new Set<string>();
  private readonly firstNames: readonly string[];
  private readonly lastNames: readonly string[];

  constructor(
    private readonly rng: Rng,
    reserved: readonly { firstName: string; lastName: string }[] = [],
    lists: NameLists = {},
  ) {
    for (const person of reserved) this.used.add(this.key(person.firstName, person.lastName));
    const extendedFirst = lists.extended ? [...PATIENT_FIRST_NAMES, ...EXTRA_PATIENT_FIRST_NAMES] : PATIENT_FIRST_NAMES;
    this.firstNames = lists.firstNames ?? extendedFirst;
    this.lastNames = lists.extended ? [...PATIENT_LAST_NAMES, ...EXTRA_PATIENT_LAST_NAMES] : PATIENT_LAST_NAMES;
  }

  next(): { firstName: string; lastName: string } {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const firstName = this.rng.pick(this.firstNames);
      const lastName = this.rng.pick(this.lastNames);
      const key = this.key(firstName, lastName);
      if (this.used.has(key)) continue;
      this.used.add(key);
      return { firstName, lastName };
    }
    throw new Error("NameFactory: ran out of unique name combinations");
  }

  private key(firstName: string, lastName: string): string {
    return `${slugify(firstName)}|${slugify(lastName)}`;
  }
}
