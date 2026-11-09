import { describe, expect, it } from "vitest";
import { fieldErrorsFromZod } from "@/lib/forms";
import { normalizeFrenchPhone, PHONE_ERROR, settingsFormValues, settingsSavedMessage, settingsSchema } from "./schema";

const defaults = {
  waitBeforeAppointmentMin: "30",
  waitAfterSessionMin: "15",
  maxTotalWaitMin: "45",
  maxDetourKmPerExtraPatient: "10",
  maxDetourKmTotal: "30",
  pickupServiceMin: "5",
  dropoffServiceMin: "5",
  unassignedPenalty: "10 000",
  solverTimeLimitSec: "10",
  replanMaxServedLoss: "0",
  replanMaxMarginLoss: "10",
  lateCancellationHours: "2",
  tripHorizonDays: "14",
  regulatorPhone: "",
};

/** Field errors exactly as the form displays them (first issue per field). */
function errorsOf(input: Record<string, string>) {
  const result = settingsSchema.safeParse(input);
  return result.success ? {} : fieldErrorsFromZod(result.error).fieldErrors;
}

describe("settingsSchema", () => {
  it("accepts the schema defaults", () => {
    expect(settingsSchema.parse(defaults)).toEqual({
      waitBeforeAppointmentMin: 30,
      waitAfterSessionMin: 15,
      maxTotalWaitMin: 45,
      maxDetourKmPerExtraPatient: 10,
      maxDetourKmTotal: 30,
      pickupServiceMin: 5,
      dropoffServiceMin: 5,
      unassignedPenalty: 10000,
      solverTimeLimitSec: 10,
      replanMaxServedLoss: 0,
      replanMaxMarginLoss: 0.1,
      lateCancellationHours: 2,
      tripHorizonDays: 14,
      regulatorPhone: null,
    });
  });

  it("takes the margin loss tolerance in % and stores it as a fraction of the revenue", () => {
    expect(settingsSchema.parse({ ...defaults, replanMaxMarginLoss: "2,5" }).replanMaxMarginLoss).toBe(0.025);
    expect(errorsOf({ ...defaults, replanMaxMarginLoss: "120" }).replanMaxMarginLoss).toMatch(/Maximum/);
    expect(errorsOf({ ...defaults, replanMaxServedLoss: "1,5" }).replanMaxServedLoss).toBe("Nombre entier attendu.");
    expect(settingsFormValues(settingsSchema.parse(defaults)).replanMaxMarginLoss).toBe("10");
  });

  it("enforces waitBefore + waitAfter <= maxTotalWait", () => {
    expect(errorsOf({ ...defaults, waitAfterSessionMin: "20" }).maxTotalWaitMin).toBe(
      "Marge avant le RDV (30 min) + marge après la séance (20 min) = 50 min : dépasse l'attente maximale de 45 min.",
    );
    expect(errorsOf({ ...defaults, maxTotalWaitMin: "40" }).maxTotalWaitMin).toMatch(/= 45 min : dépasse l'attente maximale de 40 min/);
    expect(settingsSchema.parse({ ...defaults, waitBeforeAppointmentMin: "20", maxTotalWaitMin: "35" }).maxTotalWaitMin).toBe(35);
  });

  it("caps the waits and detours at the decree limits", () => {
    expect(errorsOf({ ...defaults, maxTotalWaitMin: "60" }).maxTotalWaitMin).toMatch(/décret 2025-202/);
    expect(errorsOf({ ...defaults, maxDetourKmPerExtraPatient: "12" }).maxDetourKmPerExtraPatient).toMatch(/10 km maximum/);
    expect(errorsOf({ ...defaults, maxDetourKmTotal: "35" }).maxDetourKmTotal).toMatch(/30 km maximum/);
    expect(settingsSchema.parse({ ...defaults, maxDetourKmPerExtraPatient: "7,5", maxDetourKmTotal: "20" }).maxDetourKmPerExtraPatient).toBe(7.5);
  });

  it("keeps the per-patient detour under the total", () => {
    expect(errorsOf({ ...defaults, maxDetourKmPerExtraPatient: "10", maxDetourKmTotal: "8" }).maxDetourKmPerExtraPatient).toMatch(
      /plafond total/,
    );
  });

  it("bounds the solver time limit and the stop times", () => {
    expect(errorsOf({ ...defaults, solverTimeLimitSec: "0" }).solverTimeLimitSec).toMatch(/Minimum/);
    expect(errorsOf({ ...defaults, solverTimeLimitSec: "121" }).solverTimeLimitSec).toMatch(/Maximum : 120 s/);
    expect(errorsOf({ ...defaults, solverTimeLimitSec: "2,5" }).solverTimeLimitSec).toBe("Nombre entier attendu.");
    expect(errorsOf({ ...defaults, pickupServiceMin: "61" }).pickupServiceMin).toMatch(/Maximum/);
    expect(errorsOf({ ...defaults, unassignedPenalty: "" }).unassignedPenalty).toBe("Champ obligatoire.");
  });

  it("round-trips through the form values", () => {
    const parsed = settingsSchema.parse({ ...defaults, maxDetourKmPerExtraPatient: "7,5" });
    expect(settingsSchema.parse(settingsFormValues(parsed))).toEqual(parsed);
    const withPhone = settingsSchema.parse({ ...defaults, regulatorPhone: "+33 4 65 71 00 00" });
    expect(settingsFormValues(withPhone).regulatorPhone).toBe("04 65 71 00 00");
    expect(settingsSchema.parse(settingsFormValues(withPhone))).toEqual(withPhone);
  });
});

describe("regulation phone number", () => {
  it.each([
    "04 65 71 00 00",
    "0465710000",
    "04.65.71.00.00",
    "04-65-71-00-00",
    "+33 4 65 71 00 00",
    "+33465710000",
    "+33 (0)4 65 71 00 00",
    "0033 4 65 71 00 00",
    " 04 65 71 00 00 ",
    "04 65 71 00 00",
  ])("normalizes %j", (input) => {
    expect(normalizeFrenchPhone(input)).toBe("04 65 71 00 00");
    expect(settingsSchema.parse({ ...defaults, regulatorPhone: input }).regulatorPhone).toBe("04 65 71 00 00");
  });

  it("keeps mobile and non-geographic numbers", () => {
    expect(normalizeFrenchPhone("06.39.98.12.34")).toBe("06 39 98 12 34");
    expect(normalizeFrenchPhone("+33 9 70 00 00 00")).toBe("09 70 00 00 00");
  });

  it("stores no number when the field is blank or absent", () => {
    expect(settingsSchema.parse({ ...defaults, regulatorPhone: "   " }).regulatorPhone).toBeNull();
    const withoutPhone: Record<string, string> = { ...defaults };
    delete withoutPhone.regulatorPhone;
    expect(settingsSchema.parse(withoutPhone).regulatorPhone).toBeNull();
  });

  it.each([
    "04 65 71 00",
    "04 65 71 00 00 0",
    "4 65 71 00 00",
    "00 65 71 00 00",
    "+33 04 65 71 00 00",
    "+44 20 7946 0000",
    "04 65 71 OO OO",
    "régulation",
  ])("rejects %j with a French message", (input) => {
    expect(normalizeFrenchPhone(input)).toBeNull();
    expect(errorsOf({ ...defaults, regulatorPhone: input }).regulatorPhone).toBe(PHONE_ERROR);
  });

  it("explains the 10 digits without contradicting the +33 example", () => {
    expect(PHONE_ERROR).toBe(
      "Numéro invalide : saisissez un numéro français à 10 chiffres (ex. 04 65 71 00 00), éventuellement au format +33 4 65 71 00 00.",
    );
    // Both examples of the message are accepted as written.
    expect(normalizeFrenchPhone("04 65 71 00 00")).toBe("04 65 71 00 00");
    expect(normalizeFrenchPhone("+33 4 65 71 00 00")).toBe("04 65 71 00 00");
  });
});

describe("settingsSavedMessage", () => {
  const rules = "Paramètres enregistrés : les règles s'appliqueront au prochain calcul des tournées.";

  it("does not mention the number when it did not change", () => {
    expect(settingsSavedMessage(null, null)).toBe(rules);
    expect(settingsSavedMessage("04 65 71 00 00", "04 65 71 00 00")).toBe(rules);
  });

  it("announces a new or changed number for the next roadmap refresh", () => {
    expect(settingsSavedMessage(null, "04 65 71 00 00")).toBe(
      `${rules} Les chauffeurs verront le numéro 04 65 71 00 00 dès la prochaine actualisation de leur feuille de route.`,
    );
    expect(settingsSavedMessage("04 65 71 00 00", "04 65 71 00 01")).toMatch(/verront le numéro 04 65 71 00 01 /);
  });

  it("says when the number is removed", () => {
    expect(settingsSavedMessage("04 65 71 00 00", null)).toBe(
      `${rules} La feuille de route des chauffeurs n'affichera plus de numéro de la régulation.`,
    );
  });

  it("compares the normalized values the action stores", () => {
    const saved = settingsSchema.parse({ ...defaults, regulatorPhone: "04.65.71.00.00" }).regulatorPhone;
    expect(settingsSavedMessage("04 65 71 00 00", saved)).toBe(rules);
  });
});
