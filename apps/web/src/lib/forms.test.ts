import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  dateField,
  fieldErrorsFromZod,
  formatDecimalInput,
  isUniqueViolation,
  listOf,
  normalizeDateInput,
  numberField,
  optionalDateField,
  optionalIdField,
  optionalNumberField,
  optionalText,
  parseDecimal,
  parseTimeInput,
  readForm,
  REQUIRED,
  timeField,
  valueOf,
} from "./forms";

describe("parseDecimal", () => {
  it("accepts French and English decimals", () => {
    expect(parseDecimal("1,25")).toBe(1.25);
    expect(parseDecimal("1.25")).toBe(1.25);
    expect(parseDecimal(" 1 250,5 ")).toBe(1250.5);
    expect(parseDecimal("-3")).toBe(-3);
    expect(parseDecimal(",5")).toBe(0.5);
  });

  it("returns undefined when empty and NaN for garbage", () => {
    expect(parseDecimal("")).toBeUndefined();
    expect(parseDecimal("   ")).toBeUndefined();
    expect(parseDecimal(undefined)).toBeUndefined();
    expect(parseDecimal("abc")).toBeNaN();
    expect(parseDecimal("1.250,5")).toBeNaN();
    expect(parseDecimal("12\u00a0€")).toBeNaN();
  });
});

describe("number fields", () => {
  const field = numberField({ min: 0, max: 10, unit: "€/km" });

  it("parses and checks the range", () => {
    expect(field.parse("0,32")).toBe(0.32);
    expect(field.safeParse("11").error?.issues[0]?.message).toBe("Maximum\u00a0: 10\u00a0€/km.");
    expect(field.safeParse("-1").error?.issues[0]?.message).toBe("Minimum\u00a0: 0\u00a0€/km.");
  });

  it("distinguishes a missing value from an invalid one", () => {
    expect(field.safeParse("").error?.issues[0]?.message).toBe(REQUIRED);
    expect(field.safeParse("deux").error?.issues[0]?.message).toBe("Nombre attendu (ex. 12,5).");
  });

  it("checks integers and allows optional blanks", () => {
    const integer = optionalNumberField({ integer: true, min: 0 });
    expect(integer.parse("")).toBeUndefined();
    expect(integer.parse("3")).toBe(3);
    expect(integer.safeParse("2,5").success).toBe(false);
  });
});

describe("text and id fields", () => {
  it("turns blank optional text into null", () => {
    expect(optionalText(10).parse("  ")).toBeNull();
    expect(optionalText(10).parse(undefined)).toBeNull();
    expect(optionalText(10).parse(" ok ")).toBe("ok");
    expect(optionalText(3).safeParse("long").success).toBe(false);
  });

  it("turns an empty select into null and rejects odd ids", () => {
    expect(optionalIdField.parse("")).toBeNull();
    expect(optionalIdField.parse("cm123abc")).toBe("cm123abc");
    expect(optionalIdField.safeParse("x'; drop").success).toBe(false);
  });
});

describe("time fields (HH:MM)", () => {
  it("parses times to minutes since midnight", () => {
    expect(parseTimeInput("07:30")).toBe(450);
    expect(parseTimeInput("7:30")).toBe(450);
    expect(parseTimeInput("7h30")).toBe(450);
    expect(parseTimeInput("18h")).toBe(1080);
    expect(parseTimeInput("")).toBeUndefined();
    expect(parseTimeInput("24:00")).toBeNaN();
    expect(parseTimeInput("7.30")).toBeNaN();
  });

  it("reports a clear error", () => {
    expect(timeField().parse("06:00")).toBe(360);
    expect(timeField().safeParse("").error?.issues[0]?.message).toBe(REQUIRED);
    expect(timeField().safeParse("25:00").error?.issues[0]?.message).toMatch(/HH:MM/);
  });
});

describe("date fields", () => {
  it("accepts ISO and French dates", () => {
    expect(normalizeDateInput("01/05/2025")).toBe("2025-05-01");
    expect(normalizeDateInput("1/5/2025")).toBe("2025-05-01");
    expect(dateField().parse("2025-05-01")).toBe("2025-05-01");
    expect(dateField().parse("31/12/2025")).toBe("2025-12-31");
  });

  it("rejects impossible dates and maps blanks", () => {
    expect(dateField().safeParse("2025-02-30").success).toBe(false);
    expect(dateField().safeParse("").error?.issues[0]?.message).toBe(REQUIRED);
    expect(optionalDateField().parse("")).toBeNull();
    expect(optionalDateField().parse("2026-01-01")).toBe("2026-01-01");
  });
});

describe("readForm", () => {
  it("reads single values, checkbox groups, and skips Next internals", () => {
    const formData = new FormData();
    formData.append("label", "Taxi 1");
    formData.append("days", "1");
    formData.append("days", "3");
    formData.append("$ACTION_ID_abc", "");
    const values = readForm(formData, ["days", "qualifications"]);
    expect(values).toEqual({ label: "Taxi 1", days: ["1", "3"], qualifications: [] });
    expect(valueOf(values, "label")).toBe("Taxi 1");
    expect(valueOf(values, "missing")).toBe("");
    expect(listOf(values, "days")).toEqual(["1", "3"]);
    expect(listOf(values, "label")).toEqual(["Taxi 1"]);
  });
});

describe("fieldErrorsFromZod", () => {
  it("keeps the first message per field and collects form-level messages", () => {
    const schema = z
      .object({ a: z.string().min(2, "trop court").max(1, "jamais") })
      .refine(() => false, { message: "global" });
    const result = schema.safeParse({ a: "x" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(fieldErrorsFromZod(result.error).fieldErrors).toEqual({ a: "trop court" });
  });
});

describe("formatDecimalInput", () => {
  it("uses a decimal comma", () => {
    expect(formatDecimalInput(0.32)).toBe("0,32");
    expect(formatDecimalInput(24)).toBe("24");
    expect(formatDecimalInput(null)).toBe("");
  });
});

describe("isUniqueViolation", () => {
  it("detects Prisma P2002 on the right field", () => {
    expect(isUniqueViolation({ code: "P2002", meta: { target: ["registration"] } }, "registration")).toBe(true);
    expect(isUniqueViolation({ code: "P2002", meta: { target: ["email"] } }, "registration")).toBe(false);
    expect(isUniqueViolation({ code: "P2002", meta: { target: "User_email_key" } }, "email")).toBe(true);
    expect(
      isUniqueViolation({ code: "P2002", message: "Unique constraint failed on the fields: (`email`)" }, "email"),
    ).toBe(true);
    expect(isUniqueViolation({ code: "P2025" }, "email")).toBe(false);
    expect(isUniqueViolation(new Error("boom"), "email")).toBe(false);
  });
});
