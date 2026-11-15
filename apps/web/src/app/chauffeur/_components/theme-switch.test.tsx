// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeSwitch } from "./theme-switch";

afterEach(cleanup);

describe("ThemeSwitch (FLD-04)", () => {
  it("applies the theme to the app's frame at once and remembers it in a cookie", () => {
    // The cookie is the driver app's (Path=/chauffeur).
    window.history.pushState({}, "", "/chauffeur");
    const frame = document.createElement("div");
    frame.setAttribute("data-driver-frame", "");
    frame.dataset.theme = "auto";
    document.body.appendChild(frame);
    render(<ThemeSwitch initial="auto" />);
    expect((screen.getByLabelText("Auto") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText("Nuit"));
    expect(frame.dataset.theme).toBe("night");
    expect(document.cookie).toContain("opti-theme=night");
    expect((screen.getByLabelText("Nuit") as HTMLInputElement).checked).toBe(true);
    frame.remove();
  });
});
