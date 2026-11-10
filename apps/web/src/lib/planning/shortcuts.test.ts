// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isShortcutKey, isTypingTarget, issueTargets, nextIssueTarget } from "./shortcuts";

function key(k: string, target: EventTarget | null, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean; altGraph: boolean }> = {}) {
  return {
    key: k,
    ctrlKey: mods.ctrlKey ?? false,
    altKey: mods.altKey ?? false,
    metaKey: mods.metaKey ?? false,
    target,
    getModifierState: (m: string) => m === "AltGraph" && mods.altGraph === true,
  };
}

describe("one-key shortcuts", () => {
  it("never steal a key typed in a field or a dialog", () => {
    document.body.innerHTML = `<input id="i"/><div role="dialog"><button id="d">x</button></div><button id="b">ok</button>`;
    const input = document.getElementById("i");
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(document.getElementById("d"))).toBe(true);
    expect(isTypingTarget(document.getElementById("b"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isShortcutKey(key("f", input))).toBe(false);
    expect(isShortcutKey(key("f", document.body))).toBe(true);
  });

  it("leave Ctrl, Alt and Cmd to the browser, but accept AltGr (« [ » and « ] » on a French keyboard)", () => {
    expect(isShortcutKey(key("f", document.body, { ctrlKey: true }))).toBe(false);
    expect(isShortcutKey(key("f", document.body, { altKey: true }))).toBe(false);
    expect(isShortcutKey(key("f", document.body, { metaKey: true }))).toBe(false);
    expect(isShortcutKey(key("[", document.body, { ctrlKey: true, altKey: true, altGraph: true }))).toBe(true);
    expect(isShortcutKey({ ...key("n", document.body), defaultPrevented: true })).toBe(false);
  });
});

describe("« N » through « À traiter »", () => {
  const args = {
    planned: true,
    unassigned: [{ tripId: "u1" }, { tripId: "half", servedPartner: { tripId: "p", vehicleId: "v9" } }],
    vehicleIssues: [{ vehicleId: "v1" }],
    returnsToCheck: ["r1"],
    violations: [
      { tripId: "t1", vehicleId: null },
      { tripId: null, vehicleId: "v2" },
      { tripId: "r1", vehicleId: null },
    ],
    staleTrips: [{ tripId: "s1" }],
    droppedLocks: [{ tripId: "l1" }],
  };

  it("follows the panel's order, each entry once", () => {
    expect(issueTargets(args).map((t) => `${t.kind}:${t.id}`)).toEqual([
      "trip:half",
      "vehicle:v1",
      "trip:r1",
      "trip:t1",
      "vehicle:v2",
      "trip:u1",
      "trip:s1",
      "trip:l1",
    ]);
    // Before the first optimization, only the trips to plan.
    expect(issueTargets({ ...args, planned: false, vehicleIssues: [], returnsToCheck: [], violations: [], staleTrips: [], droppedLocks: [] }).map((t) => t.id)).toEqual([
      "u1",
      "half",
    ]);
  });

  it("goes to the entry after the selection, from the first one, and wraps around", () => {
    const targets = issueTargets(args);
    expect(nextIssueTarget(targets, { tripId: null, vehicleId: null })?.target).toEqual({ kind: "trip", id: "half" });
    expect(nextIssueTarget(targets, { tripId: "r1", vehicleId: "v3" })).toEqual({ target: { kind: "trip", id: "t1" }, index: 3 });
    expect(nextIssueTarget(targets, { tripId: null, vehicleId: "v1" })?.target).toEqual({ kind: "trip", id: "r1" });
    expect(nextIssueTarget(targets, { tripId: "l1", vehicleId: null })?.index).toBe(0);
    expect(nextIssueTarget(targets, { tripId: "elsewhere", vehicleId: null })?.index).toBe(0);
    expect(nextIssueTarget([], { tripId: null, vehicleId: null })).toBeNull();
  });
});
