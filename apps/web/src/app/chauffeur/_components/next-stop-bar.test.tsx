// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueSnapshot } from "../_lib/status-queue";
import { NextStopBar, type BarStop } from "./next-stop-bar";

const app = vi.hoisted(() => ({ submit: vi.fn(), snapshot: { byStop: {}, refusals: [] } as Pick<QueueSnapshot, "byStop" | "refusals"> }));
vi.mock("./driver-app", () => ({
  useDriverApp: () => ({ submit: app.submit }),
  useQueueSnapshot: () => app.snapshot,
}));

const stop = (id: string, kind: "PICKUP" | "DROPOFF", minute: number, extra: Partial<BarStop> = {}): BarStop => ({
  id,
  kind,
  plannedMinute: minute,
  patient: `Patient ${id}`,
  primary: kind,
  pickupStopId: null,
  blocked: false,
  lat: 43.3,
  lng: 5.4,
  call: { href: "tel:0612345678", label: "le patient" },
  ...extra,
});

let release: ReturnType<typeof vi.fn>;
beforeEach(() => {
  app.submit.mockClear();
  app.snapshot = { byStop: {}, refusals: [] };
  release = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: { request: vi.fn(async () => ({ released: false, release })) },
  });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("NextStopBar (FLD-04)", () => {
  it("offers the next stop's status, the route and a call, and keeps the screen on", async () => {
    render(<NextStopBar stops={[stop("s1", "PICKUP", 480), stop("s2", "DROPOFF", 510)]} autoScroll={false} />);
    expect(screen.getByText("· Patient s1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Pris en charge/ }));
    expect(app.submit).toHaveBeenCalledWith("s1", "PICKUP");
    expect(screen.getByRole("link", { name: /Itinéraire/ }).getAttribute("href")).toContain("google.com/maps");
    expect(screen.getByRole("link", { name: "Appeler le patient" }).getAttribute("href")).toBe("tel:0612345678");
    expect((navigator as Navigator & { wakeLock: { request: ReturnType<typeof vi.fn> } }).wakeLock.request).toHaveBeenCalledWith("screen");
  });

  it("moves on as soon as a status is tapped on the phone, and unblocks a drop-off whose pickup is tapped", () => {
    app.snapshot = { byStop: { s1: { action: "PICKUP", observedAt: 1, phase: "queued" } }, refusals: [] };
    render(<NextStopBar stops={[stop("s1", "PICKUP", 480), stop("s2", "DROPOFF", 510, { blocked: true, pickupStopId: "s1" })]} autoScroll={false} />);
    expect(screen.getByText("· Patient s2")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Déposé/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("stays on a stop with an arrival only, and goes to its card on opening once the route is under way", () => {
    app.snapshot = { byStop: { s1: { action: "ARRIVE", observedAt: 1, phase: "queued" } }, refusals: [] };
    render(<NextStopBar stops={[stop("s1", "PICKUP", 480)]} autoScroll />);
    expect(screen.getByText("· Patient s1")).toBeTruthy();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    cleanup();
    const card = document.createElement("li");
    card.id = "stop-s1";
    document.body.appendChild(card);
    render(<NextStopBar stops={[stop("s1", "PICKUP", 480)]} autoScroll />);
    expect(card.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    card.remove();
  });

  it("shows nothing once every stop has a status on the phone", () => {
    app.snapshot = { byStop: { s1: { action: "NO_SHOW", observedAt: 1, phase: "sent" } }, refusals: [] };
    const { container } = render(<NextStopBar stops={[stop("s1", "PICKUP", 480)]} autoScroll={false} />);
    expect(container.textContent).toBe("");
  });
});
