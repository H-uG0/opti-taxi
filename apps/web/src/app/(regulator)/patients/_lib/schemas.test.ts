import { beforeAll, describe, expect, it } from "vitest";
import { echoed, echoedCheckbox, echoedList, IDLE_STATE as INITIAL_FORM_STATE, type FormState } from "@/lib/forms";
import { parsePatientForm, parsePrescriptionForm, parseRecurrenceForm } from "./schemas";

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

  it("turns empty optional fields into null, and never reads « actif » (only « Désactiver » changes it)", () => {
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
    expect(fieldErrors.postalCode).toBe("Code postal : 5 chiffres");
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
    });
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
    expect(!tooLong.success && tooLong.state.fieldErrors.sessionMinutes).toMatch(/720 min/);
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
