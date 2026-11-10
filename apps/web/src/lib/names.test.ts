import { describe, expect, it } from "vitest";
import { formatPersonName } from "./names";

describe("formatPersonName", () => {
  it("writes the surname first, in capitals, as on every regulator screen", () => {
    expect(formatPersonName({ firstName: "Marie", lastName: "Dupont" })).toBe("DUPONT Marie");
    expect(formatPersonName({ firstName: " Élodie ", lastName: "de la Fontaine" })).toBe("DE LA FONTAINE Élodie");
  });

  it("keeps the initial only in a narrow cell", () => {
    expect(formatPersonName({ firstName: "élodie", lastName: "Fabre" }, "short")).toBe("FABRE É.");
    expect(formatPersonName({ firstName: "", lastName: "Fabre" }, "short")).toBe("FABRE");
  });
});
