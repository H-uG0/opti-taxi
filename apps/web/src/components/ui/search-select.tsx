"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, Search } from "lucide-react";
import { normalizeSearch } from "@/lib/list-filters";
import { cn } from "./cn";

export type SearchSelectOption = {
  value: string;
  label: string;
  /** Second line: depot and distance, vehicle, absence… */
  hint?: string;
  /** Shown but not selectable; `hint` says why. */
  disabled?: boolean;
};
export type SearchSelectGroup = {
  label: string;
  options: readonly SearchSelectOption[];
  /** Shown only once something is typed (people who could never take the seat: found when looked for by name). */
  searchOnly?: boolean;
};

/**
 * A choice in a long list (a person among 150) with a search field: a button
 * shows the choice; opened, a search field filters the options, grouped
 * (« Disponibles du dépôt », « Autres dépôts »…). The options are only built
 * and drawn while it is open: a page of 120 rows holds 120 buttons instead of
 * 20 000 <option>. Keyboard: Entrée, Espace or ↓ open; ↑ ↓ move, Entrée
 * chooses, Échap closes (the focus returns to the button), Tab leaves.
 * Combobox pattern of the ARIA practices (the search field controls a
 * listbox, the active option is read with aria-activedescendant).
 */
export function SearchSelect({
  value,
  onChange,
  options,
  selectedLabel,
  label,
  placeholder = "Rechercher un nom…",
  invalid = false,
  disabled = false,
  emptyText = "Aucun résultat",
  className,
  describedBy,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Built when the list opens (and again at each keystroke): may be costly. */
  options: () => readonly (SearchSelectOption | SearchSelectGroup)[];
  /** What the closed button shows. */
  selectedLabel: string;
  /** Accessible name (« Chauffeur de Taxi 12 »). */
  label: string;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  emptyText?: string;
  className?: string;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null);
  const id = useId();
  const listId = `${id}-list`;
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => (open ? filterGroups(options(), query) : []), [open, options, query]);
  const enabled = useMemo(() => groups.flatMap((g) => g.options.filter((o) => !o.disabled)), [groups]);
  const optionId = (v: string) => `${id}-o-${encodeURIComponent(v)}`;

  // Placed against the button, in the viewport (fixed): a frame that scrolls sideways never clips it.
  useLayoutEffect(() => {
    if (!open) return;
    const placeIt = () => {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const width = Math.max(rect.width, 320);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      if (below >= 260 || below >= above) setPlace({ left, top: rect.bottom + 4, width, maxHeight: Math.max(160, below) });
      else setPlace({ left, bottom: window.innerHeight - rect.top + 4, width, maxHeight: Math.max(160, above) });
    };
    placeIt();
    window.addEventListener("resize", placeIt);
    window.addEventListener("scroll", placeIt, true);
    return () => {
      window.removeEventListener("resize", placeIt);
      window.removeEventListener("scroll", placeIt, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  // The active option stays in view.
  useEffect(() => {
    if (open && active !== null) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
    // optionId only depends on the stable id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  const show = () => {
    if (disabled) return;
    setQuery("");
    setActive(value);
    setOpen(true);
  };
  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };
  const choose = (option: SearchSelectOption) => {
    if (option.disabled) return;
    if (option.value !== value) onChange(option.value);
    close(true);
  };
  const move = (step: 1 | -1) => {
    if (enabled.length === 0) return;
    const index = enabled.findIndex((o) => o.value === active);
    const next = index === -1 ? (step === 1 ? 0 : enabled.length - 1) : (index + step + enabled.length) % enabled.length;
    setActive(enabled[next]!.value);
  };
  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      // Never submits the surrounding form.
      event.preventDefault();
      const option = enabled.find((o) => o.value === active) ?? (enabled.length === 1 ? enabled[0] : undefined);
      if (option) choose(option);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };
  const activeShown = active !== null && enabled.some((o) => o.value === active);

  return (
    <div className={cn("relative", className)}>
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}\u00a0: ${selectedLabel}`}
        aria-describedby={describedBy}
        disabled={disabled}
        title={selectedLabel}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            show();
          }
        }}
        className={cn(
          "flex h-10 w-full items-center gap-2 rounded-md border border-field bg-white px-3 text-left text-sm text-slate-900 shadow-xs focus-visible:border-brand-600 focus-visible:outline-2 focus-visible:outline-brand-600 disabled:border-slate-300 disabled:bg-slate-100 disabled:text-slate-500",
          invalid && "border-red-500",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{selectedLabel}</span>
        <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-slate-500 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div
          ref={panel}
          className="fixed z-50 flex flex-col overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg"
          style={
            place
              ? { left: place.left, top: place.top, bottom: place.bottom, width: place.width, maxHeight: Math.min(place.maxHeight, 384) }
              : // Not placed yet (first frame): invisible but focusable, so the search field takes the focus at once.
                { left: 0, top: 0, opacity: 0 }
          }
        >
          <div className="relative border-b border-slate-200 p-2">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-slate-400" />
            <input
              ref={input}
              type="text"
              role="combobox"
              aria-label={label}
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeShown ? optionId(active) : undefined}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(null);
              }}
              onKeyDown={onInputKey}
              placeholder={placeholder}
              autoComplete="off"
              className="h-9 w-full rounded border border-field pr-2 pl-8 text-sm focus:border-brand-600 focus:outline-2 focus:outline-brand-600"
            />
          </div>
          <div id={listId} role="listbox" aria-label={label} className="min-h-0 flex-1 overflow-y-auto py-1">
            {groups.length === 0 ? <p className="px-3 py-2 text-sm text-slate-500">{emptyText}</p> : null}
            {groups.map((group, index) => (
              <div key={`${group.label}-${index}`} role="group" aria-labelledby={group.label ? `${id}-g-${index}` : undefined}>
                {group.label ? (
                  <p id={`${id}-g-${index}`} role="presentation" className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                    {group.label}
                  </p>
                ) : null}
                {group.options.map((option) => (
                  <div
                    key={option.value}
                    id={optionId(option.value)}
                    role="option"
                    aria-selected={option.value === value}
                    aria-disabled={option.disabled || undefined}
                    // The click does not take the focus from the search field.
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => choose(option)}
                    onPointerMove={() => !option.disabled && setActive(option.value)}
                    className={cn(
                      "mx-1 cursor-pointer rounded px-2 py-1.5 text-sm",
                      option.disabled ? "cursor-default text-slate-400" : "text-slate-900",
                      option.value === active && !option.disabled && "bg-brand-50",
                      option.value === value && "font-semibold",
                    )}
                  >
                    <span className="block truncate">{option.label}</span>
                    {option.hint ? (
                      <span className={cn("block truncate text-xs", option.disabled ? "text-slate-400" : "text-slate-500")}>{option.hint}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The groups whose options match every word of `query` (label and hint, accents aside); empty groups are dropped. */
export function filterGroups(
  items: readonly (SearchSelectOption | SearchSelectGroup)[],
  query: string,
): { label: string; options: SearchSelectOption[] }[] {
  const words = normalizeSearch(query).split(" ").filter(Boolean);
  const keep = (option: SearchSelectOption) => {
    if (words.length === 0) return true;
    const text = normalizeSearch(`${option.label} ${option.hint ?? ""}`);
    return words.every((word) => text.includes(word));
  };
  const groups: { label: string; options: SearchSelectOption[] }[] = [];
  for (const item of items) {
    if ("options" in item) {
      if (item.searchOnly && words.length === 0) continue;
      const options = item.options.filter(keep);
      if (options.length > 0) groups.push({ label: item.label, options });
    } else if (keep(item)) {
      const last = groups.at(-1);
      // Loose options (« — Aucun chauffeur — ») gather in an unnamed group.
      if (last && last.label === "") last.options.push(item);
      else groups.push({ label: "", options: [item] });
    }
  }
  return groups;
}
