"use client";

import { useEffect, useRef } from "react";

/** First thing to fix in a form refused by the server: an invalid field, else the form's message. */
export function errorFocusTarget(form: ParentNode): HTMLElement | null {
  const invalid = form.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])');
  if (invalid) return invalid;
  return form.querySelector<HTMLElement>('[data-form-message="error"]');
}

/**
 * Put inside a form: each time `refusal` changes to a new key (lib/forms refusalKey: the server
 * refused the submission), the focus leaves the submit button for the first invalid field, or for
 * the error message when no field is at fault. A screen reader then reads the field and its error.
 */
export function ErrorFocus({ refusal }: { refusal: number | string | null }) {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (refusal === null) return;
    const scope = marker.current?.closest("form") ?? marker.current?.parentElement;
    if (!scope) return;
    // The message may sit just above the form (outside it): look in the form, then around it.
    const target = errorFocusTarget(scope) ?? (scope.parentElement ? errorFocusTarget(scope.parentElement) : null);
    target?.focus();
  }, [refusal]);
  return <span ref={marker} hidden />;
}
