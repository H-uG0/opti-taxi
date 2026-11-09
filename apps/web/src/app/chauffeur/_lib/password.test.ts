import { describe, expect, it } from "vitest";
import { fieldsToClear, passwordChangeSchema, readPasswordForm } from "./password";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.set(key, value);
  return fd;
}

function errors(entries: Record<string, string>): Record<string, string> {
  const parsed = passwordChangeSchema.safeParse(readPasswordForm(form(entries)));
  if (parsed.success) return {};
  return Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join("."), issue.message]));
}

describe("passwordChangeSchema", () => {
  it("accepts a new password of 10 characters or more, confirmed, different from the current one", () => {
    expect(errors({ current: "prov-isoi-re12", next: "mon-propre-mdp", confirm: "mon-propre-mdp" })).toEqual({});
  });

  it("requires the current password", () => {
    expect(errors({ current: "", next: "mon-propre-mdp", confirm: "mon-propre-mdp" })).toEqual({
      current: "Saisissez votre mot de passe actuel.",
    });
  });

  it("refuses a short new password, a mismatched confirmation, and keeping the provisional one", () => {
    expect(errors({ current: "x", next: "court", confirm: "court" }).next).toBe("10 caractères minimum.");
    expect(errors({ current: "x", next: "mon-propre-mdp", confirm: "mon-propre-mdq" }).confirm).toMatch(/ne correspondent pas/);
    expect(errors({ current: "prov-isoi-re12", next: "prov-isoi-re12", confirm: "prov-isoi-re12" }).next).toMatch(
      /différent de l'actuel/,
    );
    expect(errors({ current: "x", next: "a".repeat(65), confirm: "a".repeat(65) }).next).toBe("64 caractères maximum.");
  });
});

describe("fieldsToClear", () => {
  it("empties the fields in error only, the confirmation with a refused new password", () => {
    expect([...fieldsToClear({ current: "Mot de passe actuel incorrect." })]).toEqual(["current"]);
    expect([...fieldsToClear({ next: "10 caractères minimum." })].sort()).toEqual(["confirm", "next"]);
    expect([...fieldsToClear({ confirm: "Les deux mots de passe ne correspondent pas." })]).toEqual(["confirm"]);
    expect(fieldsToClear({}).size).toBe(0);
  });
});
