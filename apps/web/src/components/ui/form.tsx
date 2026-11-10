import { Children, cloneElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { cn } from "./cn";

/**
 * Control boundary at 3:1 or more against white and the light page surfaces (WCAG 1.4.11), and a
 * 2 px brand-600 focus outline, as on the buttons. Exported for the few native inputs styled by hand.
 */
export const controlClasses =
  "block w-full rounded-md border border-field bg-white px-3 text-sm text-slate-900 shadow-xs placeholder:text-slate-500 focus:border-brand-600 focus:outline-2 focus:outline-offset-0 focus:outline-brand-600 disabled:border-slate-300 disabled:bg-slate-100 aria-[invalid=true]:border-red-600";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(controlClasses, "h-10", className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(controlClasses, "h-10 pr-8", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(controlClasses, "min-h-20 py-2", className)} {...props} />;
}

/**
 * Numeric input with its unit shown inside, right-aligned. The unit is also read with the field
 * (an sr-only description), so a label without its unit is never ambiguous for a screen reader.
 */
export function UnitInput({ unit, className, id, ...props }: ComponentProps<"input"> & { unit: string }) {
  const unitId = id ? `${id}-unit` : undefined;
  const describedBy = [props["aria-describedby"], unitId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="relative">
      <Input id={id} className={cn("tabular pr-14 text-right", className)} {...props} aria-describedby={describedBy} />
      <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-slate-600">
        {unit}
      </span>
      {unitId ? (
        <span id={unitId} className="sr-only">
          en {unit}
        </span>
      ) : null}
    </div>
  );
}

export function Checkbox({ label, className, ...props }: ComponentProps<"input"> & { label: ReactNode }) {
  return (
    <label className={cn("inline-flex min-h-6 items-center gap-2 text-sm text-slate-800", className)}>
      <input type="checkbox" className="size-4 rounded border-field accent-brand-700" {...props} />
      {label}
    </label>
  );
}

/** Ids of the hint and error lines of a field (for a control that is not the field's direct child). */
export function fieldIds(htmlFor: string) {
  return { hint: `${htmlFor}-hint`, error: `${htmlFor}-error` };
}

type ControlProps = { id?: string; "aria-describedby"?: string; "aria-invalid"?: unknown };

/**
 * Label + control + optional hint and error. `htmlFor` must match the control id.
 *
 * The hint and the error get ids derived from `htmlFor` (fieldIds); the control
 * whose id is `htmlFor` (the single child, as `<Input id=…>` or `<UnitInput id=…>`)
 * receives `aria-describedby` (its own ids first) and `aria-invalid` when there is
 * an error. A control nested deeper (in a wrapper) is left alone: link it with fieldIds.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | string[] | null;
  className?: string;
  children: ReactNode;
}) {
  const message = (Array.isArray(error) ? error[0] : error) || null;
  const ids = htmlFor ? fieldIds(htmlFor) : null;
  const showHint = Boolean(hint) && !message;
  const describedBy = ids ? (message ? ids.error : showHint ? ids.hint : null) : null;

  let control = children;
  const only = Children.count(children) === 1 ? Children.only(children) : null;
  if (ids && isValidElement<ControlProps>(only) && only.props.id === htmlFor) {
    const own = only.props["aria-describedby"];
    control = cloneElement(only as ReactElement<ControlProps>, {
      "aria-describedby": [own, describedBy].filter(Boolean).join(" ") || undefined,
      "aria-invalid": message ? true : only.props["aria-invalid"],
    });
  }

  return (
    <div className={cn("space-y-1", className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      {control}
      {showHint ? (
        <p id={ids?.hint} className="text-xs text-slate-600">
          {hint}
        </p>
      ) : null}
      {message ? (
        <p id={ids?.error} className="text-xs font-medium text-red-700">
          {message}
        </p>
      ) : null}
    </div>
  );
}

export function Fieldset({ legend, children, className }: { legend: ReactNode; children: ReactNode; className?: string }) {
  return (
    <fieldset className={cn("space-y-4 rounded-lg border border-slate-200 bg-white p-4", className)}>
      <legend className="px-1 text-sm font-semibold text-slate-900">{legend}</legend>
      {children}
    </fieldset>
  );
}

/**
 * Banner for a server action result. Focusable from script (`data-form-message`): after a refusal
 * without a field to correct, ErrorFocus moves the focus here.
 */
export function FormMessage({ tone = "error", children }: { tone?: "error" | "success" | "info"; children: ReactNode }) {
  if (!children) return null;
  const tones = {
    error: "border-red-200 bg-red-50 text-red-800",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
    info: "border-sky-200 bg-sky-50 text-sky-800",
  };
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      tabIndex={-1}
      data-form-message={tone}
      className={cn("rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand-600", tones[tone])}
    >
      {children}
    </p>
  );
}
