import { describe, expect, it } from "vitest";
import {
  DRIVER_MAX_SESSION_DAYS,
  DRIVER_RENEW_BELOW_HOURS,
  SESSION_HOURS,
  sessionExpiryFrom,
  shouldRenewSession,
  withinDriverSessionCap,
} from "./session-renewal";

const HOUR = 3_600_000;
const NOW = new Date("2026-11-10T05:30:00Z");
const endingIn = (hours: number) => new Date(NOW.getTime() + hours * HOUR);
// Password typed the evening before.
const SIGNED_IN = new Date(NOW.getTime() - 10.5 * HOUR);

describe("session renewal", () => {
  it("lasts 12\u00a0h from the signature", () => {
    expect(SESSION_HOURS).toBe(12);
    expect(sessionExpiryFrom(NOW)).toEqual(endingIn(12));
  });

  it("renews a driver's session once fewer than 5\u00a0h are left", () => {
    expect(DRIVER_RENEW_BELOW_HOURS).toBe(5);
    // Signed in at 19:00 the evening before: 1 h 30 left when the first pickups start.
    expect(shouldRenewSession("DRIVER", endingIn(1.5), NOW, SIGNED_IN)).toBe(true);
    expect(shouldRenewSession("DRIVER", endingIn(4.9), NOW, SIGNED_IN)).toBe(true);
    expect(shouldRenewSession("DRIVER", endingIn(5), NOW, SIGNED_IN)).toBe(false);
    expect(shouldRenewSession("DRIVER", endingIn(11), NOW, SIGNED_IN)).toBe(false);
  });

  it("never renews an expired session nor a regulator's", () => {
    expect(shouldRenewSession("DRIVER", endingIn(0), NOW, SIGNED_IN)).toBe(false);
    expect(shouldRenewSession("DRIVER", endingIn(-1), NOW, SIGNED_IN)).toBe(false);
    expect(shouldRenewSession("REGULATOR", endingIn(1), NOW, SIGNED_IN)).toBe(false);
  });

  it("stops renewing a driver's session 7 days after the password was typed", () => {
    expect(DRIVER_MAX_SESSION_DAYS).toBe(7);
    const days = (n: number) => new Date(NOW.getTime() - n * 24 * HOUR);
    expect(shouldRenewSession("DRIVER", endingIn(1), NOW, days(6.9))).toBe(true);
    expect(shouldRenewSession("DRIVER", endingIn(1), NOW, days(7))).toBe(false);
    expect(withinDriverSessionCap(days(7.1), NOW)).toBe(false);
    // Unknown sign-in time: never renewed.
    expect(shouldRenewSession("DRIVER", endingIn(1), NOW, null)).toBe(false);
  });
});
