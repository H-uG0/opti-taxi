// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StopFieldView } from "../_lib/view";
import { requestsSummary, StopRequests } from "./stop-requests";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./driver-app", () => ({ useDriverApp: () => ({ ownerId: "u1" }) }));
vi.mock("../_lib/reachability", () => ({ serverReachable: async () => true }));

const atDropoff: StopFieldView = {
  readyMinute: 705,
  appointmentMinute: 600,
  signalReady: true,
  cancelReturn: true,
  askReturn: false,
  nextSession: true,
  nextSessionMin: "2026-11-17",
  askCancel: false,
  sent: ["Prochaine séance le 18/11/2026 · demande envoyée à 10:05, en attente de la régulation"],
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, message: "Fin de séance transmise : retour prêt à 12:00.", serverTime: 0, sessionExpiresAt: null }) }));
  vi.stubGlobal("fetch", fetchMock);
  router.refresh.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const bodyOf = (call = 0) => JSON.parse(fetchMock.mock.calls[call]![1].body as string) as Record<string, unknown>;

describe("StopRequests", () => {
  it("names what the stop offers on its summary", () => {
    expect(requestsSummary(atDropoff)).toBe("Fin de séance, prochaine séance, annuler le retour");
    expect(requestsSummary({ ...atDropoff, signalReady: false, cancelReturn: false, nextSession: false, askReturn: true })).toBe("Demander un retour");
  });

  it("signals the end of session 15 min later than planned, and refreshes the roadmap", async () => {
    render(<StopRequests stopId="s1" view={atDropoff} />);
    expect(screen.getByText(/Prochaine séance le 18\/11\/2026/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "15 minutes plus tard" }));
    fireEvent.click(screen.getByRole("button", { name: "Patient prêt à 12:00" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("retour prêt à 12:00"));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/chauffeur/stops/s1/requests");
    expect(bodyOf()).toEqual({ kind: "READY_TIME", readyMinute: 720, ownerId: "u1" });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it("asks for the return's cancellation with a reason from the list, and passes the next session on", async () => {
    render(<StopRequests stopId="s1" view={atDropoff} />);
    const cancel = screen.getByRole("group", { name: "Annuler le retour" });
    fireEvent.change(within(cancel).getByRole("combobox"), { target: { value: "HOSPITALIZATION" } });
    fireEvent.click(within(cancel).getByRole("button", { name: "Demander l'annulation" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodyOf()).toEqual({ kind: "CANCEL", reason: "HOSPITALIZATION", target: "return", ownerId: "u1" });
    fireEvent.change(screen.getByLabelText("Date de la prochaine séance"), { target: { value: "2026-11-18" } });
    fireEvent.click(screen.getByRole("button", { name: "Transmettre la date" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bodyOf(1)).toEqual({ kind: "NEXT_SESSION", nextSessionDate: "2026-11-18", ownerId: "u1" });
  });

  it("labels each stop's fields on their own, several stops on the page", () => {
    const { container } = render(
      <>
        <StopRequests stopId="s1" view={atDropoff} />
        <StopRequests stopId="s2" view={{ ...atDropoff, signalReady: false, cancelReturn: false, askReturn: true, sent: [] }} />
      </>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(screen.getAllByLabelText("Date de la prochaine séance")).toHaveLength(2);
    expect(screen.getByLabelText("Prêt à").getAttribute("type")).toBe("time");
  });

  it("says nothing was sent without network", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    render(<StopRequests stopId="s1" view={{ ...atDropoff, signalReady: false, cancelReturn: false, nextSession: false, askCancel: true, sent: [] }} />);
    const form = screen.getByRole("group", { name: "Motif de la demande" });
    fireEvent.change(within(form).getByRole("combobox"), { target: { value: "PATIENT" } });
    fireEvent.click(within(form).getByRole("button", { name: "Demander l'annulation" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Pas de réseau"));
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
