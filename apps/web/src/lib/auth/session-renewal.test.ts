import { describe, expect, it } from "vitest";
import { DRIVER_RENEW_BELOW_HOURS, SESSION_HOURS, sessionExpiryFrom, shouldRenewSession } from "./session-renewal";

const HOUR = 3_600_000;
const NOW = new Date("2026-11-10T05:30:00Z");
const endingIn = (hours: number) => new Date(NOW.getTime() + hours * HOUR);

describe("session renewal", () => {
  it("lasts 12 h from the signature", () => {
    expect(SESSION_HOURS).toBe(12);
    expect(sessionExpiryFrom(NOW)).toEqual(endingIn(12));
  });

  it("renews a driver's session once fewer than 5 h are left", () => {
    expect(DRIVER_RENEW_BELOW_HOURS).toBe(5);
    // Signed in at 19:00 the evening before: 1 h 30 left when the first pickups start.
    expect(shouldRenewSession("DRIVER", endingIn(1.5), NOW)).toBe(true);
    expect(shouldRenewSession("DRIVER", endingIn(4.9), NOW)).toBe(true);
    expect(shouldRenewSession("DRIVER", endingIn(5), NOW)).toBe(false);
    expect(shouldRenewSession("DRIVER", endingIn(11), NOW)).toBe(false);
  });

  it("never renews an expired session nor a regulator's", () => {
    expect(shouldRenewSession("DRIVER", endingIn(0), NOW)).toBe(false);
    expect(shouldRenewSession("DRIVER", endingIn(-1), NOW)).toBe(false);
    expect(shouldRenewSession("REGULATOR", endingIn(1), NOW)).toBe(false);
  });
});
