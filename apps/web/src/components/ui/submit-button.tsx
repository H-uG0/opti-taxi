"use client";

import { useFormStatus } from "react-dom";
import type { ComponentProps } from "react";
import { Button } from "./button";

/** Submit button that disables itself and shows `pendingLabel` while its form action runs. */
export function SubmitButton({
  children,
  pendingLabel,
  disabled,
  ...props
}: ComponentProps<typeof Button> & { pendingLabel?: string }) {
  const { pending } = useFormStatus();
  // The pending state wins over the caller's `disabled`, so a form cannot be submitted twice.
  return (
    <Button type="submit" {...props} disabled={pending || disabled} aria-busy={pending}>
      {pending ? (pendingLabel ?? "Enregistrement…") : children}
    </Button>
  );
}
