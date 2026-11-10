"use client";

import { useEffect, useRef, useTransition, type ChangeEvent, type ComponentProps, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { formQuery } from "@/lib/list-filters";
import { Button, LinkButton } from "./button";
import { cn } from "./cn";
import { Input, Select } from "./form";

/**
 * The filter bar of every list (Patients, Courses, Véhicules, Chauffeurs,
 * Établissements, Équipages): a search field, choice lists and boxes, kept in
 * the URL. One way everywhere:
 * - a choice list or a box applies at once (a list browsed with the arrow
 *   keys, which changes it at each key press on Windows and Linux, once the
 *   keys stop); the search field on Entrée or « Filtrer »;
 * - « navigate » (default): the page is loaded again for the new address
 *   (the server filters, a long list is paginated). Without JavaScript the
 *   form is a plain GET form;
 * - « replace »: the page filters what it already shows and the address is
 *   rewritten in place (history.replaceState), as on the planning: nothing
 *   is reloaded (no new read in the audit trail, unsaved changes kept), and
 *   the search field applies as you type.
 * Empty fields and fields at their default (`data-default`) stay out of the
 * address. The fields follow the address (back button, « Réinitialiser »)
 * without being remounted: the focus stays where it is. Each field shows the
 * value the page applies (`data-value`, from its parsed filter), not the raw
 * address: an unknown or old value never shows a filter other than the one in force.
 */
export function FilterBar({
  action,
  label,
  resetHref,
  filtered,
  mode = "navigate",
  hidden = {},
  children,
  className,
  submitLabel = "Filtrer",
}: {
  /** Path of the list (the form's GET action). */
  action: string;
  /** Accessible name of the search region (« Filtrer les véhicules »). */
  label: string;
  /** Address without any filter; « Réinitialiser » shows when `filtered`. */
  resetHref: string;
  filtered: boolean;
  mode?: "navigate" | "replace";
  /** Parameters kept as they are (the date of a day screen). */
  hidden?: Readonly<Record<string, string>>;
  children: ReactNode;
  className?: string;
  submitLabel?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const form = useRef<HTMLFormElement>(null);
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When a key was last pressed on a choice list (performance.now()).
  const keyed = useRef(Number.NEGATIVE_INFINITY);
  const [pending, startTransition] = useTransition();

  // The fields follow the address: back button, « Réinitialiser », a link that sets a filter.
  useEffect(() => {
    if (form.current) syncFields(form.current, params);
  }, [params]);
  useEffect(() => () => clearTimeout(typing.current ?? undefined), []);

  const apply = () => {
    const element = form.current;
    if (!element) return;
    const entries = [...new FormData(element).entries()].filter((e): e is [string, string] => typeof e[1] === "string");
    const query = formQuery(entries, defaultsOf(element));
    const href = query ? `${action}?${query}` : action;
    if (mode === "replace") {
      // State null: Next.js keeps useSearchParams in step without a server round trip.
      window.history.replaceState(null, "", href);
    } else {
      startTransition(() => router.push(href, { scroll: false }));
    }
  };

  const onChange = (event: ChangeEvent<HTMLFormElement>) => {
    const target: EventTarget = event.target;
    if (target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && target.type === "checkbox")) {
      clearTimeout(typing.current ?? undefined);
      // Browsed with the keyboard: one load (and one read in the audit trail) once the keys stop, not one per key.
      if (mode === "navigate" && target instanceof HTMLSelectElement && performance.now() - keyed.current < 1000) {
        typing.current = setTimeout(apply, 400);
      } else {
        apply();
      }
    } else if (mode === "replace" && target instanceof HTMLInputElement) {
      clearTimeout(typing.current ?? undefined);
      typing.current = setTimeout(apply, 150);
    }
  };

  return (
    <form
      ref={form}
      action={action}
      method="get"
      role="search"
      aria-label={label}
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
      onChange={onChange}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLSelectElement) keyed.current = performance.now();
      }}
      className={cn("flex flex-wrap items-end gap-x-3 gap-y-2", className)}
    >
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      <div className="flex items-center gap-2">
        {mode === "navigate" ? (
          <Button type="submit" variant="secondary" disabled={pending}>
            <Search aria-hidden className="size-4" />
            {submitLabel}
          </Button>
        ) : null}
        {filtered ? (
          <LinkButton
            href={resetHref}
            variant="ghost"
            replace={mode === "replace"}
            scroll={false}
            onClick={(event) => {
              if (mode !== "replace") return;
              // In place: the page keeps what it shows (and its unsaved changes).
              event.preventDefault();
              window.history.replaceState(null, "", resetHref);
            }}
          >
            Réinitialiser
          </LinkButton>
        ) : null}
      </div>
    </form>
  );
}

/** Default values of the fields (`data-default`): left out of the address. */
function defaultsOf(form: HTMLFormElement): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const element of Array.from(form.elements)) {
    const field = element as HTMLInputElement | HTMLSelectElement;
    if (field.name && field.dataset.default !== undefined) defaults[field.name] = field.dataset.default;
  }
  return defaults;
}

/**
 * Shows in each field the filter in force: the value the page parsed
 * (`data-value`, `data-checked`), else the address's (or the default).
 * Hidden fields are left as given.
 */
function syncFields(form: HTMLFormElement, params: URLSearchParams) {
  for (const element of Array.from(form.elements)) {
    const field = element as HTMLInputElement | HTMLSelectElement;
    if (!field.name || (field instanceof HTMLInputElement && field.type === "hidden")) continue;
    const fallback = field.dataset.default ?? "";
    if (field instanceof HTMLInputElement && field.type === "checkbox") {
      const parsed = field.dataset.checked;
      field.checked = parsed !== undefined ? parsed === "true" : params.getAll(field.name).includes(field.value);
    } else if (document.activeElement !== field || field instanceof HTMLSelectElement) {
      // A search field being typed in keeps its text.
      field.value = field.dataset.value ?? params.get(field.name) ?? fallback;
    }
  }
}

const labelClass = "block text-xs font-medium text-slate-600";

/**
 * Search field of a filter bar. `defaultValue`: the search in force (as the
 * page read it). `className`: its width from the `sm` breakpoint (`sm:w-64`),
 * instead of the default `sm:w-72` (one class wins, `cn` does not merge).
 */
export function FilterSearch({
  name = "q",
  label = "Rechercher",
  className,
  ...props
}: Omit<ComponentProps<"input">, "type"> & { name?: string; label?: string }) {
  const id = `filter-${name}`;
  return (
    <div className={cn("w-full space-y-1", className ?? "sm:w-72")}>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400" />
        <Input
          id={id}
          name={name}
          type="search"
          maxLength={100}
          autoComplete="off"
          className="pl-8"
          data-value={typeof props.defaultValue === "string" ? props.defaultValue : undefined}
          {...props}
        />
      </div>
    </div>
  );
}

export type FilterOption = { value: string; label: string };
export type FilterOptionGroup = { group: string; options: readonly FilterOption[] };

/**
 * Choice list of a filter bar. `allLabel`: the first choice, no filter (value
 * ""); `defaultValue` other than "" must be given as `data-default` too, so
 * it stays out of the address.
 */
export function FilterSelect({
  name,
  label,
  value,
  options,
  allLabel,
  defaultChoice,
  className,
}: {
  name: string;
  label: string;
  /** Current value ("" for none). */
  value: string;
  options: readonly (FilterOption | FilterOptionGroup)[];
  allLabel?: string;
  /** The choice shown when the address has none (statut: « actifs »); "" by default. */
  defaultChoice?: string;
  /** Its width (`w-40`), instead of the default `w-44` (one class wins, `cn` does not merge). */
  className?: string;
}) {
  const id = `filter-${name}`;
  const shown = value || defaultChoice || "";
  return (
    <div className={cn("space-y-1", className ?? "w-44")}>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <Select id={id} name={name} defaultValue={shown} data-value={shown} data-default={defaultChoice}>
        {allLabel !== undefined ? <option value="">{allLabel}</option> : null}
        {options.map((option) =>
          "group" in option ? (
            <optgroup key={option.group} label={option.group}>
              {option.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ) : (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ),
        )}
      </Select>
    </div>
  );
}

/** Box of a filter bar (« À traiter seulement »), on the bar's baseline. */
export function FilterCheckbox({ name, value = "1", label, checked }: { name: string; value?: string; label: string; checked: boolean }) {
  return (
    <label className="inline-flex h-10 items-center gap-2 text-sm text-slate-800">
      <input
        type="checkbox"
        name={name}
        value={value}
        defaultChecked={checked}
        data-checked={checked}
        className="size-4 rounded border-slate-300 accent-brand-700"
      />
      {label}
    </label>
  );
}
