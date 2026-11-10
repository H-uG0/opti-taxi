import { describe, expect, it } from "vitest";
import { saveNotice } from "./sync-notice";

const RETIRED = "1 course a été retirée de sa tournée\u00a0: réoptimisez la journée concernée.";

describe("saveNotice", () => {
  it("renders nothing without (valid) parameters", () => {
    expect(saveNotice({})).toBeNull();
    expect(saveNotice({ courses: "0-0-0-0", tournees: "0-0-0-0" })).toBeNull();
    expect(saveNotice({ courses: "abc", tournees: "1-2" })).toBeNull();
  });

  it("tells the trip sync alone, in blue when nothing is left to do", () => {
    expect(saveNotice({ courses: "0-1-0-0" })).toEqual({ text: "Courses à venir\u00a0: 1 annulée.", needsAction: false });
  });

  it("is amber when trips left their route or were left untouched today", () => {
    expect(saveNotice({ courses: "0-0-0-1" })?.needsAction).toBe(true);
    expect(saveNotice({ courses: "0-1-1-0" })).toEqual({ text: `Courses à venir\u00a0: 1 annulée. ${RETIRED}`, needsAction: true });
  });

  it("appends the recomputation of the routes the trips left", () => {
    expect(saveNotice({ courses: "0-1-1-0", tournees: "1-0-0-0" })).toEqual({
      text: `Courses à venir\u00a0: 1 annulée. ${RETIRED} Horaires et totaux de la tournée recalculés.`,
      needsAction: true,
    });
  });

  it("does not repeat the advice to re-optimize already given for the trips taken out", () => {
    expect(saveNotice({ courses: "1-0-1-0", tournees: "0-1-0-1" })).toEqual({
      text:
        `Courses à venir\u00a0: 1 mise à jour. ${RETIRED} ` +
        "Les horaires et totaux de la tournée seront mis à jour à la prochaine optimisation (service d'optimisation indisponible).",
      needsAction: true,
    });
  });

  it("keeps the advice of a day under way (tell the driver)", () => {
    expect(saveNotice({ courses: "0-1-1-0", tournees: "0-1-0-4" })).toEqual({
      text:
        `Courses à venir\u00a0: 1 annulée. ${RETIRED} ` +
        "Les horaires et totaux de la tournée n'ont pas pu être recalculés\u00a0: ils restent ceux du dernier calcul, la journée ayant commencé. " +
        "Prévenez le chauffeur.",
      needsAction: true,
    });
  });

  it("tells the recomputation alone, with its advice, when the sync parameter is missing", () => {
    expect(saveNotice({ tournees: "2-0-1-0" })).toEqual({
      text: "Horaires et totaux de 2 tournées recalculés\u202f; 1 contrainte n'est pas respectée. Réoptimisez le planning.",
      needsAction: true,
    });
    expect(saveNotice({ tournees: "1-0-0-0" })).toEqual({
      text: "Horaires et totaux de la tournée recalculés.",
      needsAction: false,
    });
  });

  it("is amber when a route kept its old values or breaks a rule", () => {
    expect(saveNotice({ courses: "1-0-0-0", tournees: "0-1-0-0" })?.needsAction).toBe(true);
    expect(saveNotice({ courses: "1-0-0-0", tournees: "1-0-2-0" })?.needsAction).toBe(true);
    expect(saveNotice({ courses: "1-0-0-0", tournees: "1-0-0-0" })?.needsAction).toBe(false);
  });

  it("reads the first value of a repeated parameter", () => {
    expect(saveNotice({ courses: ["0-1-0-0", "9-9-9-9"], tournees: ["1-0-0-0"] })?.text).toBe(
      "Courses à venir\u00a0: 1 annulée. Horaires et totaux de la tournée recalculés.",
    );
  });
});
