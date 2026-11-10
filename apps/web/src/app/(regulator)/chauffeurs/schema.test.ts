import { describe, expect, it } from "vitest";
import { REVOKE_SESSIONS } from "@/lib/auth/revoke";
import { fieldErrorsFromZod } from "@/lib/forms";
import {
  ACCESS_STILL_DISABLED_NOTE,
  accountActiveData,
  accountSchema,
  accountUpdate,
  accountUpdateMessage,
  assignmentConflicts,
  describeBreak,
  driverFormValues,
  driverSchema,
  generatePassword,
  OPEN_SESSION_NOTE,
  PROVISIONAL_PASSWORD_NOTE,
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
      depotId: null,
    });
  });

  it("keeps the optional depot, blank meaning none", () => {
    expect(driverSchema.parse({ ...valid, depotId: "depot_gap" }).depotId).toBe("depot_gap");
    expect(driverSchema.parse({ ...valid, depotId: "" }).depotId).toBeNull();
    expect(errorsOf({ ...valid, depotId: "../x" }).depotId).toBe("Identifiant invalide.");
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

  it("accepts no break when the three break fields are blank, on a shift of 6 hours or less", () => {
    const sixHours = { ...valid, shiftEnd: "13:00" };
    const driver = driverSchema.parse({ ...sixHours, breakWindowStart: "", breakWindowEnd: "", breakMinutes: "" });
    expect(driver).toMatchObject({ breakWindowStartMinute: null, breakWindowEndMinute: null, breakMinutes: 0 });
    const zero = driverSchema.parse({ ...sixHours, breakWindowStart: "", breakWindowEnd: "", breakMinutes: "0" });
    expect(zero.breakMinutes).toBe(0);
  });

  it("requires a break of 20\u00a0min or more over 6 hours (art. L. 3121-16)", () => {
    const blank = { breakWindowStart: "", breakWindowEnd: "", breakMinutes: "" };
    expect(errorsOf({ ...valid, ...blank }).breakWindowStart).toBe(
      "Pause obligatoire pour un horaire de 11\u00a0h\u00a030\u00a0: au moins 20\u00a0min au-delà de 6\u00a0h de travail (Code du travail, art. L. 3121-16).",
    );
    expect(errorsOf({ ...valid, breakMinutes: "15" }).breakMinutes).toBe(
      "Au moins 20\u00a0min pour un horaire de 11\u00a0h\u00a030 (au-delà de 6\u00a0h de travail, Code du travail, art. L. 3121-16).",
    );
    expect(errorsOf({ ...valid, breakMinutes: "20" })).toEqual({});
    const short = { breakWindowEnd: "13:00", breakMinutes: "15" };
    expect(errorsOf({ ...valid, ...short, shiftEnd: "13:01" }).breakMinutes).toMatch(/^Au moins 20\u00a0min pour un horaire de 6\u00a0h\u00a001/);
    expect(errorsOf({ ...valid, ...short, shiftEnd: "13:00" })).toEqual({});
  });

  it("requires the break fields together", () => {
    expect(errorsOf({ ...valid, breakWindowEnd: "" }).breakWindowEnd).toMatch(/manquante/);
    expect(errorsOf({ ...valid, breakMinutes: "" }).breakMinutes).toMatch(/manquante/);
    expect(errorsOf({ ...valid, breakWindowStart: "", breakWindowEnd: "" }).breakWindowStart).toMatch(/manquant/);
  });

  it("checks the break window", () => {
    expect(errorsOf({ ...valid, breakWindowEnd: "11:00" }).breakWindowEnd).toMatch(/après son début/);
    expect(errorsOf({ ...valid, breakWindowStart: "13:30", breakMinutes: "45" }).breakMinutes).toBe(
      "La fenêtre (30\u00a0min) est plus courte que la pause (45\u00a0min).",
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
    const noBreak = { ...parsed, shiftEndMinute: 780, breakWindowStartMinute: null, breakWindowEndMinute: null, breakMinutes: 0 };
    expect(driverSchema.parse(driverFormValues(noBreak))).toEqual(noBreak);
  });

  it("describes the break", () => {
    expect(describeBreak({ breakWindowStartMinute: 690, breakWindowEndMinute: 840, breakMinutes: 45 })).toBe(
      "45\u00a0min entre 11:30 et 14:00",
    );
    expect(describeBreak({ breakWindowStartMinute: null, breakWindowEndMinute: null, breakMinutes: 0 })).toBeNull();
  });
});

describe("assignmentConflicts", () => {
  it("lists vehicles whose default crew would lose its qualification", () => {
    expect(assignmentConflicts(["DEA"], [{ label: "Ambulance 1", type: "AMBULANCE" }], [])).toEqual([]);
    expect(assignmentConflicts(["AUXILIARY"], [{ label: "VSL 1", type: "VSL" }], [])).toEqual([]);
    expect(assignmentConflicts(["TAXI_CARD"], [{ label: "VSL 1", type: "VSL" }], [])).toEqual([
      "chauffeur par défaut de «\u202fVSL 1\u202f» (requis\u00a0: Auxiliaire ambulancier ou Ambulancier DE)",
    ]);
    expect(assignmentConflicts(["TAXI_CARD"], [], [{ label: "Ambulance 2", type: "AMBULANCE" }])).toEqual([
      "équipier par défaut de «\u202fAmbulance 2\u202f» (requis\u00a0: Auxiliaire ambulancier ou Ambulancier DE)",
    ]);
  });

  it("keeps a DEA in each ambulance crew, whoever drives (R. 6312-10)", () => {
    // An auxiliary drives, the DEA is the crew mate: valid.
    expect(assignmentConflicts(["AUXILIARY"], [{ label: "Ambulance 1", type: "AMBULANCE", partner: ["DEA"] }], [])).toEqual([]);
    // The DEA of the pair loses the diploma: the pair has none left.
    expect(assignmentConflicts(["AUXILIARY"], [], [{ label: "Ambulance 1", type: "AMBULANCE", partner: ["AUXILIARY"] }])).toEqual([
      "équipier par défaut de «\u202fAmbulance 1\u202f» (l'équipage doit compter un ambulancier DE)",
    ]);
    // No partner yet: the crew mate of the day will have to be a DEA, nothing to refuse here.
    expect(assignmentConflicts(["AUXILIARY"], [{ label: "Ambulance 1", type: "AMBULANCE", partner: null }], [])).toEqual([]);
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

describe("accountActiveData", () => {
  it("ends the open sessions when disabling, not when enabling", () => {
    expect(accountActiveData(false)).toEqual({ active: false, sessionVersion: { increment: 1 } });
    expect(accountActiveData(false)).toMatchObject(REVOKE_SESSIONS);
    expect(accountActiveData(true)).toEqual({ active: true });
  });
});

describe("accountUpdate", () => {
  const current = "marc@exemple.fr";

  it("changes nothing when the e-mail is the same and no password is given", () => {
    expect(accountUpdate(current, { email: current, passwordHash: null })).toBeNull();
  });

  it("ends the open sessions on a new e-mail, keeping the password", () => {
    const update = accountUpdate(current, { email: "marc.durand@exemple.fr", passwordHash: null });
    expect(update).toEqual({
      data: { email: "marc.durand@exemple.fr", ...REVOKE_SESSIONS },
      actions: ["account.update"],
      emailChanged: true,
      passwordReset: false,
    });
  });

  it("ends the open sessions on a new password, keeping the e-mail; the password is provisional", () => {
    const update = accountUpdate(current, { email: current, passwordHash: "$2b$10$hash" });
    expect(update).toEqual({
      data: { passwordHash: "$2b$10$hash", mustChangePassword: true, ...REVOKE_SESSIONS },
      actions: ["account.password_reset"],
      emailChanged: false,
      passwordReset: true,
    });
  });

  it("records both changes when the e-mail and the password change together", () => {
    const update = accountUpdate(current, { email: "autre@exemple.fr", passwordHash: "$2b$10$hash" });
    expect(update).toEqual({
      data: { email: "autre@exemple.fr", passwordHash: "$2b$10$hash", mustChangePassword: true, ...REVOKE_SESSIONS },
      actions: ["account.update", "account.password_reset"],
      emailChanged: true,
      passwordReset: true,
    });
  });
});

describe("accountUpdateMessage", () => {
  const emailOnly = { emailChanged: true, passwordReset: false };
  const passwordOnly = { emailChanged: false, passwordReset: true };
  const both = { emailChanged: true, passwordReset: true };

  it("on an active account, asks to pass on the new credentials and says open sessions end", () => {
    expect(accountUpdateMessage(emailOnly, true)).toBe(
      `Identifiant modifié\u00a0: communiquez-le au chauffeur. Il se connecte désormais avec la nouvelle adresse et son mot de passe actuel. ${OPEN_SESSION_NOTE}`,
    );
    expect(accountUpdateMessage(passwordOnly, true)).toBe(
      "Mot de passe provisoire défini\u00a0: communiquez-le au chauffeur. L'ancien mot de passe ne permet plus de se connecter. " +
        `${PROVISIONAL_PASSWORD_NOTE} ${OPEN_SESSION_NOTE}`,
    );
    expect(accountUpdateMessage(both, true)).toBe(
      "Identifiant modifié et mot de passe provisoire défini\u00a0: communiquez-les au chauffeur. " +
        `L'ancien mot de passe ne permet plus de se connecter. ${PROVISIONAL_PASSWORD_NOTE} ${OPEN_SESSION_NOTE}`,
    );
  });

  it("on a disabled account, promises neither a sign-in nor an open session", () => {
    for (const change of [emailOnly, passwordOnly, both]) {
      const message = accountUpdateMessage(change, false);
      expect(message).toMatch(/communiquez-l/);
      expect(message.endsWith(ACCESS_STILL_DISABLED_NOTE)).toBe(true);
      expect(message).not.toContain(OPEN_SESSION_NOTE);
      expect(message).not.toMatch(/se connecte désormais|ne permet plus/);
    }
    expect(accountUpdateMessage(emailOnly, false)).toBe(
      `Identifiant modifié\u00a0: communiquez-le au chauffeur. ${ACCESS_STILL_DISABLED_NOTE}`,
    );
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
