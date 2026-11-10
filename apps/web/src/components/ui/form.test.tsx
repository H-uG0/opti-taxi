// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorFocus, errorFocusTarget } from "./error-focus";
import { Field, FormMessage, Input, UnitInput, fieldIds } from "./form";

afterEach(cleanup);

describe("Field", () => {
  it("links its hint to the control (aria-describedby), without marking it invalid", () => {
    render(
      <Field label="Nom" htmlFor="lastName" hint="Tel qu'écrit sur la carte Vitale">
        <Input id="lastName" />
      </Field>,
    );
    const input = screen.getByLabelText("Nom");
    expect(input.getAttribute("aria-describedby")).toBe("lastName-hint");
    expect(document.getElementById("lastName-hint")?.textContent).toBe("Tel qu'écrit sur la carte Vitale");
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("links the error instead of the hint, marks the control invalid, and keeps the control's own description", () => {
    render(
      <Field label="Quantité (L)" htmlFor="quantity" hint="Pour le dernier plein" error={["Nombre attendu (ex. 12,5).", "Autre"]}>
        <UnitInput id="quantity" unit="L" aria-describedby="own-note" />
      </Field>,
    );
    const input = screen.getByLabelText("Quantité (L)");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    // The control's own description, then the error, then the unit read with it.
    expect(input.getAttribute("aria-describedby")).toBe("own-note quantity-error quantity-unit");
    expect(document.getElementById("quantity-error")?.textContent).toBe("Nombre attendu (ex. 12,5).");
    expect(document.getElementById("quantity-hint")).toBeNull();
    expect(document.getElementById("quantity-unit")?.textContent).toBe("en L");
  });

  it("leaves a control nested in a wrapper alone, its ids still available", () => {
    render(
      <Field label="Ville" htmlFor="city" error="Ville obligatoire">
        <div>
          <Input id="city" />
        </div>
      </Field>,
    );
    expect(screen.getByLabelText("Ville").getAttribute("aria-invalid")).toBeNull();
    expect(fieldIds("city")).toEqual({ hint: "city-hint", error: "city-error" });
    expect(document.getElementById("city-error")?.textContent).toBe("Ville obligatoire");
  });
});

describe("ErrorFocus", () => {
  it("moves the focus to the first invalid field after a refusal", () => {
    const { rerender } = render(
      <form>
        <Field label="Nom" htmlFor="n">
          <Input id="n" />
        </Field>
        <ErrorFocus refusal={null} />
      </form>,
    );
    expect(document.activeElement).toBe(document.body);
    rerender(
      <form>
        <FormMessage>Le formulaire contient des erreurs.</FormMessage>
        <Field label="Nom" htmlFor="n" error="Nom obligatoire">
          <Input id="n" />
        </Field>
        <ErrorFocus refusal={1} />
      </form>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Nom"));
  });

  it("moves it to the message when no field is at fault", () => {
    render(
      <form>
        <FormMessage>Ce véhicule n&apos;existe plus&nbsp;: rechargez la page.</FormMessage>
        <Input aria-label="Libellé" />
        <ErrorFocus refusal={2} />
      </form>,
    );
    expect(document.activeElement).toBe(screen.getByRole("alert"));
    expect(errorFocusTarget(document.body)).toBe(screen.getByRole("alert"));
  });
});
