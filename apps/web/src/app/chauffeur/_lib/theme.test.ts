import { describe, expect, it } from "vitest";
import { parseDriverTheme, themeCookie } from "./theme";

describe("driver theme (FLD-04)", () => {
  it("reads the cookie, « auto » for anything else", () => {
    expect(parseDriverTheme("night")).toBe("night");
    expect(parseDriverTheme("day")).toBe("day");
    expect(parseDriverTheme("auto")).toBe("auto");
    expect(parseDriverTheme("<script>")).toBe("auto");
    expect(parseDriverTheme(undefined)).toBe("auto");
  });

  it("remembers it a year, for the driver app only", () => {
    expect(themeCookie("night")).toBe("opti-theme=night; Path=/chauffeur; Max-Age=31536000; SameSite=Lax");
  });
});
