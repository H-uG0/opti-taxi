import { describe, expect, it } from "vitest";
import { auditEventData, changedFields } from "./audit-events";

const regulator = { id: "u1", role: "REGULATOR" as const, name: "Régulation" };

describe("auditEventData", () => {
  it("freezes the author's name, the request origin and the details into the row", () => {
    const row = auditEventData(
      regulator,
      {
        action: "settings.update",
        entity: "AppSettings",
        entityId: "1",
        details: { regulatorPhone: { from: "04 65 71 00 00", to: null } },
      },
      { ip: "203.0.113.7", userAgentHash: "0123456789abcdef" },
    );
    expect(row).toEqual({
      userId: "u1",
      actorLabel: "Régulation",
      role: "REGULATOR",
      action: "settings.update",
      entity: "AppSettings",
      entityId: "1",
      serviceDate: null,
      ip: "203.0.113.7",
      userAgentHash: "0123456789abcdef",
      details: { regulatorPhone: { from: "04 65 71 00 00", to: null } },
    });
  });

  it("writes no author for a failed sign-in, and no details when there are none", () => {
    const failure = { action: "session.login_failed", entity: "User", details: { emailTag: "a1b2c3d4e5f6" } } as const;
    const row = auditEventData(null, failure);
    expect(row).toMatchObject({ userId: null, role: null });
    expect(row.actorLabel ?? null).toBeNull();
    expect(row.ip ?? null).toBeNull();
    expect(row.details).toEqual({ emailTag: "a1b2c3d4e5f6" });
    const view = auditEventData(regulator, { action: "plan.view", entity: "Route", serviceDate: "2026-11-10" });
    expect(view).not.toHaveProperty("details");
    expect(view.serviceDate).toEqual(new Date("2026-11-10T00:00:00.000Z"));
  });

  it("leaves the label to the database when the actor carries no name, and the row keeps its former shape", () => {
    expect(auditEventData({ id: "u1", role: "DRIVER" }, { action: "roadmap.view", entity: "Route" })).toEqual({
      userId: "u1",
      role: "DRIVER",
      action: "roadmap.view",
      entity: "Route",
      entityId: null,
      serviceDate: null,
    });
  });
});

describe("changedFields", () => {
  it("lists only the fields whose value changed, with the old and new value", () => {
    expect(
      changedFields(
        { regulatorPhone: "04 65 71 00 00", maxDetourKmTotal: 30, solverTimeLimitSec: 10 },
        { regulatorPhone: "04 65 71 00 01", maxDetourKmTotal: 30, solverTimeLimitSec: 20 },
      ),
    ).toEqual({
      regulatorPhone: { from: "04 65 71 00 00", to: "04 65 71 00 01" },
      solverTimeLimitSec: { from: 10, to: 20 },
    });
  });

  it("writes dates as days, a missing value as null, and can be restricted to some fields", () => {
    const before = { validFrom: new Date("2026-01-01T00:00:00.000Z"), validTo: null, notes: "a" };
    const after = {
      validFrom: new Date("2026-02-01T00:00:00.000Z"),
      validTo: new Date("2026-12-31T00:00:00.000Z"),
      notes: "b",
    };
    expect(changedFields(before, after, ["validFrom", "validTo"])).toEqual({
      validFrom: { from: "2026-01-01", to: "2026-02-01" },
      validTo: { from: null, to: "2026-12-31" },
    });
    expect(changedFields({}, { a: 1 })).toEqual({ a: { from: null, to: 1 } });
  });
});
