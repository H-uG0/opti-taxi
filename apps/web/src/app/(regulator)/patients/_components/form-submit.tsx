"use client";

import { startTransition, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * Submit handler of the referential forms: dispatches the action itself, in
 * a transition, instead of letting React run it as the form `action`.
 *
 * React resets a form after its function `action` completes. A reset puts
 * every uncontrolled <select> back on the option it had at mount (the
 * echoed `defaultValue` is not re-applied to `defaultSelected`) and every
 * controlled checkbox back to its mount-time state, while the component
 * state still shows the regulator's choices: after a rejected submit, the
 * next one would silently post values nobody chose (sharing, mode,
 * mobility, legs, weekdays…). Submitting this way keeps the form exactly as
 * typed. The form keeps `action={formAction}` so it still posts before
 * hydration.
 */
export function submitWithoutReset(dispatch: (formData: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  };
}

/** Submit button driven by the `isPending` flag of useActionState. */
export function FormSubmitButton({
  pending,
  children,
  pendingLabel = "Enregistrement…",
}: {
  pending: boolean;
  children: ReactNode;
  pendingLabel?: string;
}) {
  return (
    <Button type="submit" disabled={pending} aria-busy={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
