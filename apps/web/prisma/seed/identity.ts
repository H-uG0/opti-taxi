/**
 * Invented identities: random first name x last name combinations, street
 * addresses and phone numbers taken from the ranges ARCEP reserves for fiction
 * (they are never assigned to a real subscriber).
 */
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

/** prenom.nom@opti-taxi.test, ASCII and lowercase. */
export function devEmail(firstName: string, lastName: string): string {
  return `${slugify(firstName)}.${slugify(lastName)}@opti-taxi.test`;
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

/** Hands out unique invented first name / last name pairs. */
export class NameFactory {
  private readonly used = new Set<string>();

  constructor(
    private readonly rng: Rng,
    reserved: readonly { firstName: string; lastName: string }[] = [],
  ) {
    for (const person of reserved) this.used.add(this.key(person.firstName, person.lastName));
  }

  next(): { firstName: string; lastName: string } {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const firstName = this.rng.pick(PATIENT_FIRST_NAMES);
      const lastName = this.rng.pick(PATIENT_LAST_NAMES);
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
