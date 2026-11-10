"use client";

import { startTransition, type FormEvent } from "react";

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
 * hydration. The button clicked is posted with its name and value, as a
 * native submit would (e.g. « Créer quand même »).
 */
export function submitWithoutReset(dispatch: (formData: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const formData = new FormData(event.currentTarget, submitter instanceof HTMLButtonElement && submitter.name ? submitter : null);
    startTransition(() => dispatch(formData));
  };
}
