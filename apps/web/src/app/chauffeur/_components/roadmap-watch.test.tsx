// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangedPill, ChangedRing, RoadmapChangeBanner, RoadmapWatchProvider } from "./roadmap-watch";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./driver-app", () => ({ useDriverApp: () => ({ ownerId: "u1" }) }));
vi.mock("../_lib/reachability", () => ({ serverReachable: async () => true }));

const pending = {
  vehicleId: "v1",
  version: 2,
  fingerprint: "f2",
  pending: { changedAt: "2026-11-16T09:42:00.000Z", text: "1 course retirée, 1 décalée", removed: [{ tripId: "t9", kind: "PICKUP" as const, minute: 630 }], highlight: ["t2/PICKUP"] },
};

function answer(routes: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ ok: true, serverTime: Date.now(), routes, sessionExpiresAt: null }) } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  router.refresh.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderWatch(fingerprint: string) {
  return render(
    <RoadmapWatchProvider date="2026-11-16" routes={[{ vehicleId: "v1", fingerprint }]}>
      <RoadmapChangeBanner labels={{ v1: "Taxi 8" }} />
      <ul>
        <li data-testid="changed" className="relative">
          <ChangedRing changeKey="t2/PICKUP" />
          <ChangedPill changeKey="t2/PICKUP" />
        </li>
        <li data-testid="same">
          <ChangedPill changeKey="t3/PICKUP" />
        </li>
      </ul>
    </RoadmapWatchProvider>,
  );
}

describe("Changes of the roadmap made by the regulation", () => {
  it("tells the crew what changed and when, highlights the stops, and acknowledges with « J'ai vu »", async () => {
    fetchMock.mockResolvedValueOnce(answer([pending])).mockResolvedValueOnce(answer([{ ...pending, pending: null }]));
    renderWatch("f2");
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("Modifié par la régulation à 10:42 : 1 course retirée, 1 décalée");
    expect(banner.textContent).toContain("Retirée : prise en charge prévue à 10:30");
    expect(screen.getByTestId("changed").textContent).toContain("Modifié");
    expect(screen.getByTestId("same").textContent).toBe("");
    // Asked once, with the page's account; no patient data goes out.
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({ date: "2026-11-16", ownerId: "u1" });
    // The page shows the roadmap as it is now: no refresh.
    expect(router.refresh).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "J'ai vu" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string)).toEqual({ date: "2026-11-16", ownerId: "u1", ack: { vehicleId: "v1", version: 2 } });
    expect(screen.getByTestId("changed").textContent).toBe("");
  });

  it("says when « J'ai vu » did not go through, and keeps the banner", async () => {
    fetchMock.mockResolvedValueOnce(answer([pending])).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderWatch("f2");
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "J'ai vu" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Pas de réseau"));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "J'ai vu" })).toBeTruthy();
  });

  it("draws the page again when the roadmap shown is not the one stored", async () => {
    fetchMock.mockResolvedValue(answer([{ ...pending, pending: null }]));
    renderWatch("f1");
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
  });

  it("checks again when the roadmap comes back to the screen", async () => {
    fetchMock.mockResolvedValue(answer([{ ...pending, pending: null }]));
    renderWatch("f2");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
