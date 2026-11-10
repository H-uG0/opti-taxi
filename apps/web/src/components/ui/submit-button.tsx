"use client";

import { useFormStatus } from "react-dom";
import type { ComponentProps } from "react";
import { Button } from "./button";
import { SAVING_LABEL } from "@/lib/forms";

/**
 * Submit button that disables itself and shows `pendingLabel` while its form action runs.
 * `pending` overrides the form status: a form submitted by script (submitWithoutReset) passes
 * useActionState's flag, which useFormStatus does not see.
 */
export function SubmitButton({
  children,
  pendingLabel,
  pending: pendingProp,
  disabled,
  ...props
}: ComponentProps<typeof Button> & { pendingLabel?: string; pending?: boolean }) {
  const status = useFormStatus();
  const pending = pendingProp ?? status.pending;
  // The pending state wins over the caller's `disabled`, so a form cannot be submitted twice.
  return (
    <Button type="submit" {...props} disabled={pending || disabled} aria-busy={pending}>
      {pending ? (pendingLabel ?? SAVING_LABEL) : children}
    </Button>
  );
}
