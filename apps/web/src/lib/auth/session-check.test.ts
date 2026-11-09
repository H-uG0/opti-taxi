import { describe, expect, it } from "vitest";
import {
  accountRefusal,
  passwordVersion,
  sessionIsCurrent,
  type AccountState,
  type SessionClaims,
} from "./session-check";

const HASH = "$2b$10$abcdefghijklmnopqrstuuJ0nM2l5f3oXg1yq0p2n7n8j9k0l1m2";
const OTHER_HASH = "$2b$10$zyxwvutsrqponmlkjihgfeuJ0nM2l5f3oXg1yq0p2n7n8j9k0l1m2";

function driverAccount(overrides: Partial<AccountState> = {}): AccountState {
  return {
    name: "Paul Martin",
    role: "DRIVER",
    active: true,
    driverId: "drv_1",
    passwordHash: HASH,
    sessionVersion: 3,
    mustChangePassword: false,
    driver: { active: true },
    ...overrides,
  };
}

function regulatorAccount(overrides: Partial<AccountState> = {}): AccountState {
  return {
    name: "Régulation",
    role: "REGULATOR",
    active: true,
    driverId: null,
    passwordHash: HASH,
    sessionVersion: 0,
    mustChangePassword: false,
    driver: null,
    ...overrides,
  };
}

/** Claims of a session opened on `account` (what createSession signs). */
function claimsFor(account: AccountState, id = "usr_1"): SessionClaims {
  return {
    id,
    name: account.name,
    role: account.role,
    driverId: account.driverId,
    passwordVersion: passwordVersion(account.passwordHash),
    sessionVersion: account.sessionVersion,
  };
}

describe("passwordVersion", () => {
  it("is a stable 16-hex-digit fingerprint that changes with the hash", () => {
    expect(passwordVersion(HASH)).toMatch(/^[0-9a-f]{16}$/);
    expect(passwordVersion(HASH)).toBe(passwordVersion(HASH));
    expect(passwordVersion(OTHER_HASH)).not.toBe(passwordVersion(HASH));
  });
});

describe("accountRefusal", () => {
  it("accepts an active regulator and an active driver linked to an active driver record", () => {
    expect(accountRefusal(regulatorAccount())).toBeNull();
    expect(accountRefusal(driverAccount())).toBeNull();
  });

  it("refuses a disabled account first", () => {
    expect(accountRefusal(driverAccount({ active: false }))).toBe("inactive");
    expect(accountRefusal(driverAccount({ active: false, driverId: null, driver: null }))).toBe("inactive");
    expect(accountRefusal(regulatorAccount({ active: false }))).toBe("inactive");
  });

  it("refuses a driver account without an active driver record", () => {
    // Driver record deleted: User.driverId is set to null (onDelete: SetNull).
    expect(accountRefusal(driverAccount({ driverId: null, driver: null }))).toBe("no-active-driver");
    expect(accountRefusal(driverAccount({ driver: null }))).toBe("no-active-driver");
    expect(accountRefusal(driverAccount({ driver: { active: false } }))).toBe("no-active-driver");
  });

  it("refuses any account linked to a deactivated driver record", () => {
    expect(accountRefusal(regulatorAccount({ driverId: "drv_1", driver: { active: false } }))).toBe("no-active-driver");
  });
});

describe("sessionIsCurrent", () => {
  it("keeps a session whose account has not changed, with the account's current name", () => {
    const account = driverAccount();
    const claims = claimsFor(account);
    expect(sessionIsCurrent(claims, account)).toEqual({
      id: "usr_1",
      name: "Paul Martin",
      role: "DRIVER",
      driverId: "drv_1",
      mustChangePassword: false,
    });
    // Renaming the driver record renames the session, without ending it.
    expect(sessionIsCurrent(claims, { ...account, name: "Paul Martin-Durand" })?.name).toBe("Paul Martin-Durand");
    const regulator = regulatorAccount();
    expect(sessionIsCurrent(claimsFor(regulator), regulator)).toEqual({
      id: "usr_1",
      name: "Régulation",
      role: "REGULATOR",
      driverId: null,
      mustChangePassword: false,
    });
  });

  it("keeps the session of an account with a provisional password, and says so", () => {
    const account = driverAccount({ mustChangePassword: true });
    expect(sessionIsCurrent(claimsFor(account), account)?.mustChangePassword).toBe(true);
  });

  it("ends the session of a deleted account", () => {
    expect(sessionIsCurrent(claimsFor(driverAccount()), null)).toBeNull();
  });

  it("ends the session when the account or the driver is deactivated", () => {
    const account = driverAccount();
    const claims = claimsFor(account);
    expect(sessionIsCurrent(claims, { ...account, active: false })).toBeNull();
    expect(sessionIsCurrent(claims, { ...account, driver: { active: false } })).toBeNull();
  });

  it("ends the session when the role or the driver link changed", () => {
    const account = driverAccount();
    const claims = claimsFor(account);
    expect(sessionIsCurrent(claims, { ...account, role: "REGULATOR", driverId: null, driver: null })).toBeNull();
    expect(sessionIsCurrent(claims, { ...account, driverId: "drv_2" })).toBeNull();
    const regulator = regulatorAccount();
    expect(sessionIsCurrent(claimsFor(regulator), { ...regulator, role: "DRIVER", driverId: "drv_1", driver: { active: true } })).toBeNull();
  });

  it("ends the session when the password hash changed (reset)", () => {
    const account = driverAccount();
    expect(sessionIsCurrent(claimsFor(account), { ...account, passwordHash: OTHER_HASH })).toBeNull();
  });

  it("refuses a token issued before the password fingerprint existed (no pwv claim)", () => {
    const account = regulatorAccount();
    expect(sessionIsCurrent({ ...claimsFor(account), passwordVersion: null }, account)).toBeNull();
  });

  it("refuses a driver session without a driver record, so /login and /chauffeur do not bounce", () => {
    // Driver record deleted, then a new sign-in: claims and account both carry driverId null.
    const orphan = driverAccount({ driverId: null, driver: null });
    expect(sessionIsCurrent(claimsFor(orphan), orphan)).toBeNull();
  });

  it("a deactivation that bumps the session version is not undone by a reactivation (lost phone)", () => {
    const account = driverAccount();
    const lostPhone = claimsFor(account);
    // Deactivation bumps the version (REVOKE_SESSIONS), then the regulator
    // reactivates the access, password unchanged.
    const deactivated = { ...account, active: false, sessionVersion: account.sessionVersion + 1 };
    expect(sessionIsCurrent(lostPhone, deactivated)).toBeNull();
    const reactivated = { ...deactivated, active: true };
    expect(sessionIsCurrent(lostPhone, reactivated)).toBeNull();
    // A new sign-in on the spare phone carries the new version.
    expect(sessionIsCurrent(claimsFor(reactivated), reactivated)).not.toBeNull();
  });

  it("only suspends the session when the deactivation keeps the session version", () => {
    // Why deactivating must spread REVOKE_SESSIONS: flipping `active` alone
    // lets the same cookie back in once the account is active again.
    const account = driverAccount();
    const claims = claimsFor(account);
    expect(sessionIsCurrent(claims, { ...account, active: false })).toBeNull();
    expect(sessionIsCurrent(claims, account)).not.toBeNull();
  });
});

describe("sessionIsCurrent: session version", () => {
  it("keeps a session opened with the account's current version", () => {
    const account = driverAccount({ sessionVersion: 7 });
    expect(sessionIsCurrent({ ...claimsFor(account), sessionVersion: 7 }, account)).not.toBeNull();
    const fresh = regulatorAccount({ sessionVersion: 0 });
    expect(sessionIsCurrent(claimsFor(fresh), fresh)).not.toBeNull();
  });

  it("ends a session opened before a logout, deactivation or new password (older version)", () => {
    const account = driverAccount({ sessionVersion: 7 });
    expect(sessionIsCurrent({ ...claimsFor(account), sessionVersion: 6 }, account)).toBeNull();
    expect(sessionIsCurrent({ ...claimsFor(account), sessionVersion: 0 }, account)).toBeNull();
  });

  it("refuses a version the account never had (newer than the account's)", () => {
    const account = regulatorAccount({ sessionVersion: 2 });
    expect(sessionIsCurrent({ ...claimsFor(account), sessionVersion: 3 }, account)).toBeNull();
  });

  it("refuses a token issued before the session version existed (no sv claim), even on a version-0 account", () => {
    const account = regulatorAccount({ sessionVersion: 0 });
    expect(sessionIsCurrent({ ...claimsFor(account), sessionVersion: null }, account)).toBeNull();
  });

  it("still checks the password fingerprint when the version matches", () => {
    const account = driverAccount();
    expect(sessionIsCurrent(claimsFor(account), { ...account, passwordHash: OTHER_HASH })).toBeNull();
  });
});
