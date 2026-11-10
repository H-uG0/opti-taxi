import { describe, expect, it } from "vitest";
import {
  activationEvent,
  alreadyInStateMessage,
  patientUpdateEvents,
  renewalEvents,
  tripCancelEvents,
  tripDetachEvents,
} from "./audit-events";

describe("activationEvent", () => {
  it("names the verb after the new state, on the right entity", () => {
    expect(activationEvent("patient", "p1", false)).toEqual({ action: "patient.deactivate", entity: "Patient", entityId: "p1" });
    expect(activationEvent("recurrence", "r1", true)).toEqual({
      action: "recurrence.reactivate",
      entity: "Recurrence",
      entityId: "r1",
    });
    expect(activationEvent("facility", "f1", false)).toEqual({ action: "facility.deactivate", entity: "Facility", entityId: "f1" });
  });
});

describe("patientUpdateEvents", () => {
  const update = { action: "patient.update", entity: "Patient", entityId: "p1" };

  it("records the update alone when this save did not switch «\u202factif\u202f»", () => {
    expect(patientUpdateEvents("p1", { value: true, switched: false })).toEqual([update]);
    // A stale form repeating a deactivation done meanwhile by someone else.
    expect(patientUpdateEvents("p1", { value: false, switched: false })).toEqual([update]);
  });

  it("adds the (de)activation this save applied", () => {
    expect(patientUpdateEvents("p1", { value: false, switched: true })).toEqual([
      update,
      { action: "patient.deactivate", entity: "Patient", entityId: "p1" },
    ]);
    expect(patientUpdateEvents("p1", { value: true, switched: true })).toEqual([
      update,
      { action: "patient.reactivate", entity: "Patient", entityId: "p1" },
    ]);
  });
});

describe("alreadyInStateMessage", () => {
  it("tells that nothing changed, in the record's gender", () => {
    expect(alreadyInStateMessage("patient", false)).toBe("Ce patient était déjà désactivé\u00a0: rien n'a été modifié.");
    expect(alreadyInStateMessage("patient", true)).toBe("Ce patient était déjà actif\u00a0: rien n'a été modifié.");
    expect(alreadyInStateMessage("recurrence", false)).toBe("Cette récurrence était déjà désactivée\u00a0: rien n'a été modifié.");
    expect(alreadyInStateMessage("recurrence", true)).toBe("Cette récurrence était déjà active\u00a0: rien n'a été modifié.");
    expect(alreadyInStateMessage("facility", false)).toBe("Cet établissement était déjà désactivé\u00a0: rien n'a été modifié.");
    expect(alreadyInStateMessage("facility", true)).toBe("Cet établissement était déjà actif\u00a0: rien n'a été modifié.");
  });
});

describe("renewalEvents", () => {
  it("records one event per recurrence moved", () => {
    expect(renewalEvents(["r1", "r2"])).toEqual([
      { action: "recurrence.attach_renewal", entity: "Recurrence", entityId: "r1" },
      { action: "recurrence.attach_renewal", entity: "Recurrence", entityId: "r2" },
    ]);
    expect(renewalEvents([])).toEqual([]);
  });
});

describe("tripCancelEvents", () => {
  it("records one trip.cancel per trip, on its service day, with ids only", () => {
    // A trip as the sync reads it: addresses must never reach the trace.
    const trip = { id: "t1", serviceDate: "2026-11-04", pickupAddress: "4 avenue Jean Jaurès, 04100 Manosque", dropoffLat: 43.3 };
    expect(tripCancelEvents([trip, { id: "t2", serviceDate: "2026-11-05" }])).toEqual([
      { action: "trip.cancel", entity: "Trip", entityId: "t1", serviceDate: "2026-11-04" },
      { action: "trip.cancel", entity: "Trip", entityId: "t2", serviceDate: "2026-11-05" },
    ]);
    expect(tripCancelEvents([])).toEqual([]);
  });
});

describe("tripDetachEvents", () => {
  it("records trip.detach with ids and service days only", () => {
    const trip = { id: "t1", serviceDate: "2026-11-04", pickupAddress: "4 avenue Jean Jaurès, 04100 Manosque" };
    expect(tripDetachEvents([trip])).toEqual([{ action: "trip.detach", entity: "Trip", entityId: "t1", serviceDate: "2026-11-04" }]);
  });
});
