import { describe, expect, it } from "vitest";
import { formatSessionEnd, SESSION_WARNING_MS, sessionNotice } from "./session-notice";

// 2026-11-09 is in winter time: Paris = UTC + 1.
const NOW = Date.parse("2026-11-09T13:00:00Z");
const MIN = 60_000;

describe("sessionNotice", () => {
  it("says until when the session is valid", () => {
    expect(sessionNotice(Date.parse("2026-11-09T16:30:00Z"), NOW, false)).toEqual({ kind: "valid", until: "17:30" });
    expect(sessionNotice(Date.parse("2026-11-10T04:12:00Z"), NOW, false)).toEqual({ kind: "valid", until: "demain 05:12" });
  });

  it("warns 30 min before the end", () => {
    expect(SESSION_WARNING_MS).toBe(30 * MIN);
    expect(sessionNotice(NOW + 30 * MIN, NOW, false)).toEqual({ kind: "ending", until: "14:30", minutesLeft: 30 });
    expect(sessionNotice(NOW + 31 * MIN, NOW, false).kind).toBe("valid");
    expect(sessionNotice(NOW + 20_000, NOW, false)).toMatchObject({ kind: "ending", minutesLeft: 1 });
  });

  it("is over at the end, or as soon as the server said so", () => {
    expect(sessionNotice(NOW, NOW, false)).toEqual({ kind: "expired" });
    expect(sessionNotice(NOW + 5 * 60 * MIN, NOW, true)).toEqual({ kind: "expired" });
    expect(sessionNotice(null, NOW, false)).toEqual({ kind: "unknown" });
  });
});

describe("formatSessionEnd", () => {
  it("writes a later day as a date", () => {
    expect(formatSessionEnd(new Date("2026-11-12T08:00:00Z"), new Date(NOW))).toBe("12/11 09:00");
  });
});
