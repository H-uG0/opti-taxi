// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueSnapshot } from "../_lib/status-queue";
import { LateEntry } from "./late-entry";

const app = vi.hoisted(() => ({ submit: vi.fn(), snapshot: { byStop: {}, refusals: [] } as Pick<QueueSnapshot, "byStop" | "refusals"> }));
vi.mock("./driver-app", () => ({
  useDriverApp: () => ({ submit: app.submit, cancelQueued: vi.fn() }),
  useQueueSnapshot: () => ({ ...app.snapshot, sessionLost: null, pending: 0 }),
}));

afterEach(cleanup);
beforeEach(() => {
  app.submit.mockClear();
  app.snapshot = { byStop: {}, refusals: [] };
});

const pickup = { stopId: "s3", kind: "PICKUP" as const, plannedMinute: 480, patient: "Jeanne MARTIN", town: "Manosque", pickupStopId: null };

describe("LateEntry (« Fin de tournée », FLD-02)", () => {
  it("enters a forgotten pickup at the real time typed, the planned one by default", () => {
    render(<LateEntry {...pickup} />);
    expect((screen.getByLabelText("Heure réelle") as HTMLInputElement).value).toBe("08:00");
    fireEvent.change(screen.getByLabelText("Heure réelle"), { target: { value: "08:07" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer «\u202fPris en charge\u202f» à 08:07" }));
    expect(app.submit).toHaveBeenCalledWith("s3", "PICKUP", { declaredMinute: 487 });
  });

  it("asks the reason of an absence before sending it", () => {
    render(<LateEntry {...pickup} />);
    fireEvent.click(screen.getByLabelText("Patient absent"));
    const save = screen.getByRole("button", { name: /Enregistrer «\u202fPatient absent\u202f»/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Motif"), { target: { value: "REFUSED" } });
    fireEvent.click(save);
    expect(app.submit).toHaveBeenCalledWith("s3", "NO_SHOW", { declaredMinute: 480, reason: "REFUSED" });
  });

  it("waits for the pickup of the same patient before its drop-off, unless the pickup is already on the phone", () => {
    const dropoff = { ...pickup, stopId: "s4", kind: "DROPOFF" as const, plannedMinute: 500, pickupStopId: "s3" };
    render(<LateEntry {...dropoff} />);
    expect(screen.getByText("Saisissez d'abord la prise en charge de ce patient.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Enregistrer «\u202fDéposé\u202f»/ }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    app.snapshot = { byStop: { s3: { action: "PICKUP", observedAt: 1, phase: "queued", declaredMinute: 480 } }, refusals: [] };
    render(<LateEntry {...dropoff} />);
    expect((screen.getByRole("button", { name: /Enregistrer «\u202fDéposé\u202f»/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the status entered, waiting or sent, with the time typed", () => {
    app.snapshot = { byStop: { s3: { action: "PICKUP", observedAt: 1, phase: "queued", declaredMinute: 487 } }, refusals: [] };
    render(<LateEntry {...pickup} />);
    expect(screen.getByRole("status").textContent).toContain("Pris en charge à 08:07");
  });
});
