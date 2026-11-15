// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueSnapshot } from "../_lib/status-queue";
import { OdometerCard, parseKm } from "./odometer-card";

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

const last = { date: "2026-11-14", km: 120_380 };

describe("OdometerCard (FLD-03)", () => {
  it("reads the km as typed on a phone", () => {
    expect(parseKm("120 420")).toBe(120_420);
    expect(parseKm("120.420")).toBe(120_420);
    expect(parseKm("120 420")).toBe(120_420);
    expect(parseKm("12,5")).toBeNull();
    expect(parseKm("")).toBeNull();
  });

  it("saves the start of the day in the queue, with the last mileage known as a hint", () => {
    render(<OdometerCard routeId="r1" date="2026-11-16" moment="START" recorded={null} lastKnown={last} startKm={null} prominent />);
    expect(document.body.textContent?.replace(/\s+/gu, " ")).toContain("Dernier relevé connu : 120 380 km (14/11/2026).");
    fireEvent.change(screen.getByLabelText("Compteur au départ"), { target: { value: "120 420" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    expect(app.submit).toHaveBeenCalledWith("odometer:r1:START", "ODOMETER", { km: 120_420 });
  });

  it("refuses a decrease on the phone, and asks to confirm an unusual jump", () => {
    render(<OdometerCard routeId="r1" date="2026-11-16" moment="START" recorded={null} lastKnown={last} startKm={null} />);
    fireEvent.change(screen.getByLabelText("Compteur au départ"), { target: { value: "120000" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    expect(screen.getByText(/Inférieur au dernier relevé connu/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Compteur au départ"), { target: { value: "125000" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    expect(app.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirmer 125 000 km" }));
    expect(app.submit).toHaveBeenCalledWith("odometer:r1:START", "ODOMETER", { km: 125_000, confirmed: true });
  });

  it("shows a reading waiting on the phone, and the one recorded with « Corriger »", () => {
    app.snapshot = { byStop: { "odometer:r1:END": { action: "ODOMETER", observedAt: 1, phase: "queued", km: 120_650 } }, refusals: [] };
    render(<OdometerCard routeId="r1" date="2026-11-16" moment="END" recorded={null} lastKnown={last} startKm={120_420} />);
    expect(screen.getByText(/Compteur au retour/).textContent).toContain("120 650 km");
    expect(screen.getByRole("status").textContent).toContain("En attente d'envoi");
    cleanup();
    app.snapshot = { byStop: {}, refusals: [] };
    render(<OdometerCard routeId="r1" date="2026-11-16" moment="END" recorded={120_650} lastKnown={last} startKm={120_420} />);
    fireEvent.click(screen.getByRole("button", { name: "Corriger" }));
    expect((screen.getByLabelText("Compteur au retour") as HTMLInputElement).value).toBe("120650");
  });
});
