import { describe, expect, it } from "vitest";
import { HistoryError } from "./errors";
import { DEFAULT_HISTORY_DAYS, parseHistoryArgs } from "./options";

describe("parseHistoryArgs", () => {
  it("defaults to 20 days and the settings' time limit", () => {
    expect(parseHistoryArgs([])).toEqual({ days: DEFAULT_HISTORY_DAYS, budgetSec: null, help: false });
    expect(DEFAULT_HISTORY_DAYS).toBe(20);
  });

  it("reads --days and --budget in both spellings, ignoring pnpm's --", () => {
    expect(parseHistoryArgs(["--", "--days", "5", "--budget=3"])).toEqual({ days: 5, budgetSec: 3, help: false });
    expect(parseHistoryArgs(["--days=12"]).days).toBe(12);
    expect(parseHistoryArgs(["-h"]).help).toBe(true);
  });

  it("refuses unknown options and out-of-range values with a French message", () => {
    expect(() => parseHistoryArgs(["--jours", "3"])).toThrow(HistoryError);
    expect(() => parseHistoryArgs(["--days"])).toThrow(/nombre entier/);
    expect(() => parseHistoryArgs(["--days", "0"])).toThrow(/entre 1 et 60/);
    expect(() => parseHistoryArgs(["--budget", "2.5"])).toThrow(/nombre entier/);
    expect(() => parseHistoryArgs(["--budget", "601"])).toThrow(/entre 1 et 600/);
  });
});
