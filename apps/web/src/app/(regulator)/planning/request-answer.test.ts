import { describe, expect, it } from "vitest";
import { requestAnswer } from "./request-answer";

const outbound = { direction: "OUTBOUND" as const, patientName: "Denise Faure" };
const back = { direction: "RETURN" as const, status: "ASSIGNED" as const, readyMinute: 705 };

describe("requestAnswer", () => {
  it("cancels an outbound with its return for the reasons « Annuler la course » takes the return along for, and says so", () => {
    expect(requestAnswer({ request: { kind: "CANCEL", cancellationReason: "HOSPITALIZATION" }, trip: outbound, status: "ASSIGNED", otherLeg: back })).toEqual({
      kind: "cancel",
      withReturn: true,
      label: "Annuler l'aller et le retour",
      question: "Annuler l'aller et le retour de Denise Faure (patient hospitalisé) ? Ils sortent de leur tournée.",
      confirmLabel: "Oui, annuler l'aller et le retour",
    });
  });

  it("keeps the return for another reason, and says it stays", () => {
    expect(requestAnswer({ request: { kind: "CANCEL", cancellationReason: "OWN_MEANS" }, trip: outbound, status: "ASSIGNED", otherLeg: back })).toMatchObject({
      withReturn: false,
      question: "Annuler l'aller de Denise Faure (rentre par ses propres moyens) ? Il sort de sa tournée ; le retour (fin de séance 11:45) reste prévu.",
    });
    // A return already picked up (or a return asked to be cancelled) is not taken along.
    expect(requestAnswer({ request: { kind: "CANCEL", cancellationReason: "FACILITY" }, trip: outbound, status: "ASSIGNED", otherLeg: { ...back, status: "PICKED_UP" } })).toMatchObject({
      withReturn: false,
      question: "Annuler la course de Denise Faure (séance annulée ou reportée) ? Elle sort de sa tournée.",
    });
  });

  it("offers to close a request done otherwise meanwhile", () => {
    expect(requestAnswer({ request: { kind: "CANCEL", cancellationReason: "PATIENT" }, trip: undefined, status: "CANCELLED", otherLeg: undefined })).toEqual({
      kind: "settled",
      label: "Clore la demande (course déjà annulée)",
    });
    expect(requestAnswer({ request: { kind: "RETURN", cancellationReason: null }, trip: outbound, status: "DROPPED_OFF", otherLeg: back })).toMatchObject({ kind: "settled" });
    expect(requestAnswer({ request: { kind: "RETURN", cancellationReason: null }, trip: outbound, status: "DROPPED_OFF", otherLeg: undefined })).toEqual({ kind: "return" });
  });
});
