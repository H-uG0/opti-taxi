import { describe, expect, it } from "vitest";
import { fieldErrorsFromZod } from "@/lib/forms";
import {
  accountSchema,
  assignmentConflicts,
  describeBreak,
  driverFormValues,
  driverSchema,
  generatePassword,
} from "./schema";

const valid = {
  firstName: " Marc ",
  lastName: "Durand",
  phone: "06 12 34 56 78",
  qualifications: ["DEA", "TAXI_CARD"],
  workDays: ["5", "1", "3", "3"],
  shiftStart: "07:00",
  shiftEnd: "18:30",
  breakWindowStart: "11:30",
  breakWindowEnd: "14:00",
  breakMinutes: "45",
  hourlyCost: "24,5",
};

/** Field errors exactly as the form displays them (first issue per field). */
function errorsOf(input: Record<string, string | string[]>) {
  const result = driverSchema.safeParse(input);
  return result.success ? {} : fieldErrorsFromZod(result.error).fieldErrors;
}

describe("driverSchema", () => {
  it("converts HH:MM to minutes and normalises lists", () => {
    expect(driverSchema.parse(valid)).toEqual({
      firstName: "Marc",
      lastName: "Durand",
      phone: "06 12 34 56 78",
      qualifications: ["TAXI_CARD", "DEA"],
      workDays: [1, 3, 5],
      shiftStartMinute: 420,
      shiftEndMinute: 1110,
      breakWindowStartMinute: 690,
      breakWindowEndMinute: 840,
      breakMinutes: 45,
      hourlyCost: 24.5,
    });
  });

  it("requires at least one qualification and one work day", () => {
    expect(errorsOf({ ...valid, qualifications: [] }).qualifications).toMatch(/au moins une qualification/);
    expect(errorsOf({ ...valid, workDays: [] }).workDays).toMatch(/au moins un jour/);
    expect(errorsOf({ ...valid, workDays: ["8"] }).workDays).toBe("Jour invalide.");
    expect(errorsOf({ ...valid, qualifications: ["PILOT"] }).qualifications).toBe("Qualification inconnue.");
  });

  it("rejects invalid times and a shift ending before it starts", () => {
    expect(errorsOf({ ...valid, shiftStart: "7h" }).shiftStart).toBeUndefined();
    expect(errorsOf({ ...valid, shiftStart: "25:00" }).shiftStart).toMatch(/HH:MM/);
    expect(errorsOf({ ...valid, shiftEnd: "06:00" }).shiftEnd).toMatch(/après le début/);
    expect(errorsOf({ ...valid, shiftEnd: "07:00" }).shiftEnd).toMatch(/après le début/);
  });

  it("accepts no break when the three break fields are blank", () => {
    const driver = driverSchema.parse({ ...valid, breakWindowStart: "", breakWindowEnd: "", breakMinutes: "" });
    expect(driver).toMatchObject({ breakWindowStartMinute: null, breakWindowEndMinute: null, breakMinutes: 0 });
    const zero = driverSchema.parse({ ...valid, breakWindowStart: "", breakWindowEnd: "", breakMinutes: "0" });
    expect(zero.breakMinutes).toBe(0);
  });

  it("requires the break fields together", () => {
    expect(errorsOf({ ...valid, breakWindowEnd: "" }).breakWindowEnd).toMatch(/manquante/);
    expect(errorsOf({ ...valid, breakMinutes: "" }).breakMinutes).toMatch(/manquante/);
    expect(errorsOf({ ...valid, breakWindowStart: "", breakWindowEnd: "" }).breakWindowStart).toMatch(/manquant/);
  });

  it("checks the break window", () => {
    expect(errorsOf({ ...valid, breakWindowEnd: "11:00" }).breakWindowEnd).toMatch(/après son début/);
    expect(errorsOf({ ...valid, breakWindowStart: "13:30", breakMinutes: "45" }).breakMinutes).toBe(
      "La fenêtre (30 min) est plus courte que la pause (45 min).",
    );
    expect(errorsOf({ ...valid, breakWindowStart: "06:00" }).breakWindowStart).toMatch(/07:00 – 18:30/);
    expect(errorsOf({ ...valid, breakWindowEnd: "19:00" }).breakWindowStart).toMatch(/comprise dans les horaires/);
    expect(errorsOf({ ...valid, breakMinutes: "300" }).breakMinutes).toMatch(/Maximum/);
  });

  it("validates cost and phone", () => {
    expect(errorsOf({ ...valid, hourlyCost: "" }).hourlyCost).toBe("Champ obligatoire.");
    expect(errorsOf({ ...valid, hourlyCost: "-2" }).hourlyCost).toMatch(/Minimum/);
    expect(errorsOf({ ...valid, phone: "appelez-moi" }).phone).toMatch(/Numéro invalide/);
    expect(driverSchema.parse({ ...valid, phone: "" }).phone).toBeNull();
  });

  it("round-trips a record through the form values", () => {
    const parsed = driverSchema.parse(valid);
    expect(driverSchema.parse(driverFormValues(parsed))).toEqual(parsed);
    const noBreak = { ...parsed, breakWindowStartMinute: null, breakWindowEndMinute: null, breakMinutes: 0 };
    expect(driverSchema.parse(driverFormValues(noBreak))).toEqual(noBreak);
  });

  it("describes the break", () => {
    expect(describeBreak({ breakWindowStartMinute: 690, breakWindowEndMinute: 840, breakMinutes: 45 })).toBe(
      "45 min entre 11:30 et 14:00",
    );
    expect(describeBreak({ breakWindowStartMinute: null, breakWindowEndMinute: null, breakMinutes: 0 })).toBeNull();
  });
});

describe("assignmentConflicts", () => {
  it("lists vehicles whose default crew would lose its qualification", () => {
    expect(assignmentConflicts(["DEA"], [{ label: "Ambulance 1", type: "AMBULANCE" }], [])).toEqual([]);
    expect(assignmentConflicts(["AUXILIARY"], [{ label: "Ambulance 1", type: "AMBULANCE" }], [])).toEqual([
      "chauffeur par défaut de « Ambulance 1 » (requis : Ambulancier DE)",
    ]);
    expect(assignmentConflicts(["TAXI_CARD"], [], [{ label: "Ambulance 2", type: "AMBULANCE" }])).toEqual([
      "équipier par défaut de « Ambulance 2 » (requis : Auxiliaire ambulancier ou Ambulancier DE)",
    ]);
  });
});

describe("accountSchema", () => {
  const create = accountSchema({ requirePassword: true });
  const update = accountSchema({ requirePassword: false });

  it("lowercases the e-mail and requires a 10-character password on creation", () => {
    expect(create.parse({ email: " Marc.Durand@Exemple.fr ", password: "abcdefghij", passwordConfirm: "abcdefghij" })).toEqual({
      email: "marc.durand@exemple.fr",
      password: "abcdefghij",
    });
    const missing = create.safeParse({ email: "a@b.fr", password: "", passwordConfirm: "" });
    expect(missing.error?.issues[0]?.message).toMatch(/obligatoire/);
    const short = create.safeParse({ email: "a@b.fr", password: "abc", passwordConfirm: "abc" });
    expect(short.error?.issues[0]?.message).toBe("10 caractères minimum.");
  });

  it("checks the confirmation", () => {
    const result = create.safeParse({ email: "a@b.fr", password: "abcdefghij", passwordConfirm: "abcdefghik" });
    expect(result.error?.issues[0]?.path).toEqual(["passwordConfirm"]);
  });

  it("keeps the current password when left blank on update", () => {
    expect(update.parse({ email: "a@b.fr", password: "", passwordConfirm: "" })).toEqual({ email: "a@b.fr", password: null });
  });

  it("rejects an invalid e-mail", () => {
    expect(update.safeParse({ email: "pas-un-email" }).error?.issues[0]?.message).toBe("Adresse e-mail invalide.");
    expect(update.safeParse({ email: "" }).error?.issues[0]?.message).toBe("Champ obligatoire.");
  });
});

describe("generatePassword", () => {
  it("produces three groups of four unambiguous characters", () => {
    const password = generatePassword((array) => {
      array.forEach((_, i) => (array[i] = i * 7));
      return array;
    });
    expect(password).toMatch(/^[a-zA-Z2-9]{4}-[a-zA-Z2-9]{4}-[a-zA-Z2-9]{4}$/);
    expect(password).not.toMatch(/[01lIO]/);
    expect(password.length).toBeGreaterThanOrEqual(10);
  });
});
