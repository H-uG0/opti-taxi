// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateNav } from "./date-nav";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => new URLSearchParams("depot=d1&zoom=4h") }));
vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
    useLinkStatus: () => ({ pending: false }),
  };
});

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/planning?date=2026-11-10&depot=d1&zoom=4h&trip=t1");
});

describe("DateNav", () => {
  it("goes to the previous and next day with « [ » and « ] », keeping the filters but not the trip", () => {
    render(<DateNav date="2026-11-10" tomorrow="2026-11-11" keepParams={["depot", "zoom"]} shortcuts />);
    fireEvent.keyDown(document.body, { key: "[" });
    expect(router.push).toHaveBeenLastCalledWith("/planning?date=2026-11-09&depot=d1&zoom=4h");
    // AltGr on a French keyboard (Ctrl + Alt on Windows).
    fireEvent.keyDown(document.body, { key: "]", ctrlKey: true, altKey: true, modifierAltGraph: true });
    expect(router.push).toHaveBeenLastCalledWith("/planning?date=2026-11-11&depot=d1&zoom=4h");
    expect(screen.getByRole("link", { name: "Jour suivant" }).getAttribute("aria-keyshortcuts")).toBe("]");
  });

  it("leaves the keys alone without shortcuts, and while typing", () => {
    const { unmount } = render(<DateNav date="2026-11-10" tomorrow="2026-11-11" />);
    fireEvent.keyDown(document.body, { key: "]" });
    expect(router.push).not.toHaveBeenCalled();
    unmount();
    render(<DateNav date="2026-11-10" tomorrow="2026-11-11" shortcuts />);
    fireEvent.keyDown(screen.getByLabelText("Date du planning"), { key: "]" });
    expect(router.push).not.toHaveBeenCalled();
  });
});
