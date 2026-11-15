// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallHelp } from "./install-help";

function phone(userAgent: string, standalone = false) {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: userAgent });
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: standalone && query.includes("standalone"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("InstallHelp (FLD-04)", () => {
  it("gives the iPhone's two steps, and hides for 30 days on « Plus tard »", () => {
    phone(IPHONE);
    render(<InstallHelp />);
    expect(screen.getByText(/Sur l'écran d'accueil/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plus tard" }));
    expect(screen.queryByText(/Installer la feuille de route/)).toBeNull();
    expect(Number(window.localStorage.getItem("opti-taxi:install-dismissed"))).toBeGreaterThan(0);
  });

  it("offers Android's own prompt once the browser gives it, and nothing once installed", async () => {
    phone(ANDROID);
    render(<InstallHelp />);
    expect(screen.queryByText(/Installer la feuille de route/)).toBeNull();
    const prompt = vi.fn(async () => undefined);
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt, userChoice: Promise.resolve({ outcome: "accepted" }) });
    act(() => {
      window.dispatchEvent(event);
    });
    fireEvent.click(screen.getByRole("button", { name: /Installer l'application/ }));
    expect(prompt).toHaveBeenCalled();
    cleanup();
    phone(IPHONE, true);
    render(<InstallHelp />);
    expect(screen.queryByText(/Installer la feuille de route/)).toBeNull();
  });
});
