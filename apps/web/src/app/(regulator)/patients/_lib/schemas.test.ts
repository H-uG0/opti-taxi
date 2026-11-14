import { beforeAll, describe, expect, it } from "vitest";
import { echoed, echoedCheckbox, echoedList, IDLE_STATE as INITIAL_FORM_STATE, type FormState } from "@/lib/forms";
import { parsePatientForm, parsePrescriptionForm, parseRecurrenceForm, parseRegularPatientForm } from "./schemas";

// The first Date/Intl call of a process initialises ICU time zones, which takes
// several seconds on slow machines: pay it once here, outside the test timeouts.
beforeAll(() => {
  new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC" }).format(new Date("2026-01-01T00:00:00.000Z"));
}, 60_000);

function form(entries: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    if (Array.isArray(value)) for (const v of value) fd.append(key, v);
    else fd.set(key, value);
  }
  return fd;
}

const patient = {
  lastName: " Durand ",
  firstName: "Marie",
  phone: "06 12 34 56 78",
  address: "4 avenue Jean Jaurès",
  postalCode: "04100",
  city: "Manosque",
  lat: "43,8297",
  lng: "5,7864",
  mobility: "SEATED",
  accessNotes: "Code 1234B, 2e étage",
  active: "on",
};

describe("parsePatientForm", () => {
  it("parses a valid patient", () => {
    const result = parsePatientForm(form(patient));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      lastName: "Durand",
      firstName: "Marie",
      phone: "06 12 34 56 78",
      address: "4 avenue Jean Jaurès",
      postalCode: "04100",
      city: "Manosque",
      lat: 43.8297,
      lng: 5.7864,
      mobility: "SEATED",
      accessNotes: "Code 1234B, 2e étage",
    });
  });

  it("turns empty optional fields into null, and never reads «\u202factif\u202f» (only «\u202fDésactiver\u202f» changes it)", () => {
    const fd = form({ ...patient, phone: "", accessNotes: "  " });
    fd.delete("active");
    const result = parsePatientForm(fd);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.phone).toBeNull();
    expect(result.data.accessNotes).toBeNull();
    expect("active" in result.data).toBe(false);
  });

  it("returns per-field errors and echoes the typed values", () => {
    const result = parsePatientForm(
      form({ ...patient, lastName: "", postalCode: "4100", lat: "200", mobility: "FLYING", phone: "abc" }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const { fieldErrors, values, message } = result.state;
    expect(message).toMatch(/erreurs/);
    expect(fieldErrors.lastName).toBe("Nom obligatoire");
    expect(fieldErrors.postalCode).toBe("Code postal\u00a0: 5 chiffres");
    expect(fieldErrors.lat).toMatch(/hors de France/);
    expect(fieldErrors.mobility).toBe("Choisissez une mobilité");
    expect(fieldErrors.phone).toMatch(/téléphone invalide/);
    expect(fieldErrors.firstName).toBeUndefined();
    expect(values?.postalCode).toBe("4100");
    expect(values?.active).toBeUndefined();
  });
});

const prescription = {
  mode: "TAP",
  sharing: "BOTH",
  validFrom: "2026-09-01",
  validTo: "2027-02-28",
  isSeries: "on",
  prescriber: "Dr Martin",
  notes: "",
};

describe("parsePrescriptionForm", () => {
  it("parses a valid prescription", () => {
    const result = parsePrescriptionForm(form(prescription));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      mode: "TAP",
      sharing: "BOTH",
      validFrom: "2026-09-01",
      validTo: "2027-02-28",
      isSeries: true,
      prescriber: "Dr Martin",
      notes: null,
    });
  });

  it("accepts a one-day prescription", () => {
    expect(parsePrescriptionForm(form({ ...prescription, validTo: "2026-09-01" })).success).toBe(true);
  });

  it("rejects validTo before validFrom on the validTo field", () => {
    const result = parsePrescriptionForm(form({ ...prescription, validTo: "2026-08-31" }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.state.fieldErrors.validTo).toMatch(/postérieure au début/);
  });

  it("rejects missing and impossible dates", () => {
    const result = parsePrescriptionForm(form({ ...prescription, validFrom: "", validTo: "2026-02-30" }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.state.fieldErrors.validFrom).toBe("Début de validité obligatoire");
    expect(result.state.fieldErrors.validTo).toMatch(/invalide/);
  });

  it("forces sharing to NONE for an ambulance prescription", () => {
    const result = parsePrescriptionForm(form({ ...prescription, mode: "AMBULANCE", sharing: "BOTH" }));
    expect(result.success && result.data.sharing).toBe("NONE");
  });

  it("rejects unknown enum values", () => {
    const result = parsePrescriptionForm(form({ ...prescription, mode: "VSL", sharing: "ALL" }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.state.fieldErrors.mode).toBe("Choisissez le mode prescrit");
    expect(result.state.fieldErrors.sharing).toBe("Choisissez le partage autorisé");
  });
});

const recurrence = {
  facilityId: "fac_1",
  prescriptionId: "pre_1",
  label: "Dialyse",
  weekdays: ["5", "1", "3"],
  appointmentTime: "07:30",
  sessionMinutes: "240",
  legs: "BOTH",
  startDate: "2026-11-02",
  endDate: "",
};

describe("parseRecurrenceForm", () => {
  it("parses a valid recurrence into minutes and sorted ISO weekdays", () => {
    const result = parseRecurrenceForm(form(recurrence));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      facilityId: "fac_1",
      prescriptionId: "pre_1",
      label: "Dialyse",
      weekdays: [1, 3, 5],
      appointmentMinute: 450,
      sessionMinutes: 240,
      legs: "BOTH",
      startDate: "2026-11-02",
      endDate: null,
      notes: null,
      intervalWeeks: 1,
      sessionDates: [],
      daySchedules: [],
    });
  });

  it("reads a rhythm every other week, and refuses an unknown frequency", () => {
    const result = parseRecurrenceForm(form({ ...recurrence, frequency: "2" }));
    expect(result.success && result.data.intervalWeeks).toBe(2);
    const bad = parseRecurrenceForm(form({ ...recurrence, frequency: "12" }));
    expect(!bad.success && bad.state.fieldErrors.frequency).toBe("Choisissez une fréquence");
  });

  it("takes the weekdays and the period of explicit dates (a 21-day chemotherapy cycle)", () => {
    const result = parseRecurrenceForm(
      form({ ...recurrence, frequency: "dates", weekdays: [], startDate: "", sessionDates: "07/12/2026\n16/11/2026, 2026-12-28" }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      sessionDates: ["2026-11-16", "2026-12-07", "2026-12-28"],
      weekdays: [1],
      startDate: "2026-11-16",
      endDate: "2026-12-28",
      intervalWeeks: 1,
    });
  });

  it("names the explicit dates it cannot read, and requires one", () => {
    const bad = parseRecurrenceForm(form({ ...recurrence, frequency: "dates", sessionDates: "16/11/2026 31/02/2027" }));
    expect(!bad.success && bad.state.fieldErrors.sessionDates).toBe("Date invalide\u00a0: 31/02/2027 (JJ/MM/AAAA)");
    expect(!bad.success && bad.state.fieldErrors).not.toHaveProperty("weekdays");
    const none = parseRecurrenceForm(form({ ...recurrence, frequency: "dates", sessionDates: " " }));
    expect(!none.success && none.state.fieldErrors.sessionDates).toBe("Saisissez au moins une date de séance");
  });

  it("keeps a weekday's own time and session length, only for the days of the rhythm and when they differ", () => {
    const result = parseRecurrenceForm(
      form({ ...recurrence, dayTime3: "13:00", daySession3: "", dayTime5: "07:30", daySession5: "180", dayTime2: "09:00" }),
    );
    expect(result.success && result.data.daySchedules).toEqual([
      { weekday: 3, appointmentMinute: 780, sessionMinutes: null },
      { weekday: 5, appointmentMinute: null, sessionMinutes: 180 },
    ]);
  });

  it("checks a weekday's own time, and a return of that day ending after midnight", () => {
    const bad = parseRecurrenceForm(form({ ...recurrence, dayTime1: "7h", daySession3: "abc" }));
    expect(!bad.success && bad.state.fieldErrors.dayTime1).toMatch(/Heure invalide/);
    expect(!bad.success && bad.state.fieldErrors.daySession3).toMatch(/minutes entières/);
    const late = parseRecurrenceForm(form({ ...recurrence, dayTime5: "21:30" }));
    expect(!late.success && late.state.fieldErrors.daySession5).toMatch(/minuit/);
  });

  it("keeps the instructions for the crew, trimmed, within 500 characters", () => {
    const result = parseRecurrenceForm(form({ ...recurrence, notes: "  Salle 3, apporter le coussin  " }));
    expect(result.success && result.data.notes).toBe("Salle 3, apporter le coussin");
    const tooLong = parseRecurrenceForm(form({ ...recurrence, notes: "x".repeat(501) }));
    expect(!tooLong.success && tooLong.state.fieldErrors.notes).toMatch(/Texte des consignes trop long/);
  });

  it("requires at least one weekday and rejects invalid ones", () => {
    const none = parseRecurrenceForm(form({ ...recurrence, weekdays: [] }));
    expect(!none.success && none.state.fieldErrors.weekdays).toBe("Cochez au moins un jour");
    const bad = parseRecurrenceForm(form({ ...recurrence, weekdays: ["0", "8"] }));
    expect(bad.success).toBe(false);
  });

  it("validates the appointment time and the session duration", () => {
    const result = parseRecurrenceForm(form({ ...recurrence, appointmentTime: "25:00", sessionMinutes: "-5" }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.state.fieldErrors.appointmentTime).toMatch(/Heure invalide/);
    expect(result.state.fieldErrors.sessionMinutes).toMatch(/minutes entières/);
    const tooLong = parseRecurrenceForm(form({ ...recurrence, sessionMinutes: "800" }));
    expect(!tooLong.success && tooLong.state.fieldErrors.sessionMinutes).toMatch(/720\u00a0min/);
  });

  it("rejects an end date before the start date", () => {
    const result = parseRecurrenceForm(form({ ...recurrence, endDate: "2026-11-01" }));
    expect(!result.success && result.state.fieldErrors.endDate).toMatch(/postérieure à la date de début/);
    expect(parseRecurrenceForm(form({ ...recurrence, endDate: "2026-11-02" })).success).toBe(true);
  });

  it("refuses a return leg ready after midnight but allows it for an outbound-only recurrence", () => {
    const late = { ...recurrence, appointmentTime: "22:00", sessionMinutes: "180" };
    const both = parseRecurrenceForm(form(late));
    expect(!both.success && both.state.fieldErrors.sessionMinutes).toMatch(/minuit/);
    expect(parseRecurrenceForm(form({ ...late, legs: "OUTBOUND" })).success).toBe(true);
  });

  it("requires a facility and a prescription", () => {
    const result = parseRecurrenceForm(form({ ...recurrence, facilityId: "", prescriptionId: "" }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.state.fieldErrors.facilityId).toBe("Choisissez un établissement");
    expect(result.state.fieldErrors.prescriptionId).toBe("Choisissez une prescription");
    expect(result.state.values?.weekdays).toEqual(["5", "1", "3"]);
  });
});

describe("echoed form values", () => {
  const rejected: FormState = {
    status: "error",
    message: "x",
    fieldErrors: {},
    values: { lastName: "Typed", weekdays: ["1", "3"], other: "x" },
    submissionId: 1,
  };

  it("uses initial values before any submit", () => {
    expect(echoed(INITIAL_FORM_STATE, "lastName", "Init")).toBe("Init");
    expect(echoedCheckbox(INITIAL_FORM_STATE, "active", true)).toBe(true);
    expect(echoedList(INITIAL_FORM_STATE, "weekdays", ["2"])).toEqual(["2"]);
  });

  it("uses the typed values after a rejected submit", () => {
    expect(echoed(rejected, "lastName", "Init")).toBe("Typed");
    expect(echoedCheckbox(rejected, "active", true)).toBe(false);
    expect(echoedList(rejected, "weekdays", ["2"])).toEqual(["1", "3"]);
    expect(echoedList(rejected, "other", [])).toEqual(["x"]);
  });
});

describe("parseRegularPatientForm («\u202fNouveau patient régulier\u202f»)", () => {
  const rhythm: Partial<typeof recurrence> = { ...recurrence };
  delete rhythm.prescriptionId;
  const regular = {
    ...patient,
    mode: "TAP",
    sharing: "BOTH",
    validFrom: "2026-11-01",
    validTo: "2027-04-30",
    isSeries: "on",
    prescriber: "Dr Martin",
    ...rhythm,
    notes: "Salle 3",
  };

  it("reads the patient, the prescription and the rhythm of one form", () => {
    const result = parseRegularPatientForm(form(regular));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.patient).toMatchObject({ lastName: "Durand", city: "Manosque", accessNotes: "Code 1234B, 2e étage" });
    expect(result.data.prescription).toMatchObject({ mode: "TAP", validTo: "2027-04-30", isSeries: true, prescriber: "Dr Martin", notes: null });
    expect(result.data.recurrence).toEqual({
      facilityId: "fac_1",
      label: "Dialyse",
      weekdays: [1, 3, 5],
      appointmentMinute: 450,
      sessionMinutes: 240,
      legs: "BOTH",
      startDate: "2026-11-02",
      endDate: null,
      notes: "Salle 3",
      intervalWeeks: 1,
      sessionDates: [],
      daySchedules: [],
    });
  });

  it("reports the errors of the three parts at once, and keeps what was typed", () => {
    const result = parseRegularPatientForm(form({ ...regular, lastName: "", validTo: "", weekdays: [] }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(Object.keys(result.state.fieldErrors).sort()).toEqual(["lastName", "validTo", "weekdays"]);
    expect(result.state.values).toMatchObject({ firstName: "Marie", mode: "TAP", appointmentTime: "07:30" });
    expect(result.state.fieldErrors).not.toHaveProperty("prescriptionId");
  });

  it("starts the sessions inside the prescription's validity", () => {
    const early = parseRegularPatientForm(form({ ...regular, startDate: "2026-10-15" }));
    expect(!early.success && early.state.fieldErrors.startDate).toMatch(/validité de la prescription/);
    const late = parseRegularPatientForm(form({ ...regular, startDate: "2027-05-02" }));
    expect(!late.success && late.state.fieldErrors.startDate).toMatch(/validité de la prescription/);
  });
});
