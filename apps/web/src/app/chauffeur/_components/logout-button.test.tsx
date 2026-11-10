// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogoutButton } from "./logout-button";

const queue = vi.hoisted(() => ({ pending: 0 }));
vi.mock("./driver-app", () => ({ useQueueSnapshot: () => ({ pending: queue.pending }) }));
vi.mock("@/app/login/actions", () => ({ logout: vi.fn() }));

afterEach(cleanup);

describe("Déconnexion with statuses not yet sent", () => {
  it("drops the question when the queue empties, and does not bring it back with the next queued status", () => {
    queue.pending = 2;
    const { rerender } = render(<LogoutButton stacked={false} />);
    const trigger = screen.getByRole("button", { name: "Déconnexion" });
    fireEvent.click(trigger);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rester connecté" }));

    // Sent meanwhile: the question goes, the focus comes back to « Déconnexion ».
    queue.pending = 0;
    rerender(<LogoutButton stacked={false} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // A new status queued offline: nothing pops up by itself.
    queue.pending = 1;
    rerender(<LogoutButton stacked={false} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
