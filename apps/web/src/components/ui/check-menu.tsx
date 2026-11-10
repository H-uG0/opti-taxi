"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "./cn";

export type CheckMenuOption = { value: string; label: ReactNode; hint?: ReactNode };

/**
 * Multiple choice behind a button (« Dépôts : Gap, Sisteron ▾ »): a list of
 * checkboxes that applies each change at once. Nothing checked means « all ».
 * Closes on Escape (focus back on the button) and on a click outside.
 */
export function CheckMenu({
  label,
  summary,
  options,
  selected,
  onChange,
  allLabel = "Tous",
  className,
}: {
  /** What is chosen (« Dépôts »), read before the summary. */
  label: string;
  /** What the button shows after the label: « tous », « Gap, Sisteron », « 3 ». */
  summary: string;
  options: readonly CheckMenuOption[];
  selected: readonly string[];
  onChange: (values: string[]) => void;
  allLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const active = selected.length > 0;

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    // The first choice gets the focus: the list is used from the keyboard at once.
    wrapper.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const toggle = (value: string) => {
    const next = selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
    // Keep the options' order in the result (and in the URL).
    onChange(options.map((o) => o.value).filter((v) => next.includes(v)));
  };

  return (
    <div
      ref={wrapper}
      className={cn("relative", className)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-8 max-w-56 items-center gap-1 rounded-md border px-2.5 text-sm whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
          active ? "border-brand-300 bg-brand-50 text-brand-900" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
        )}
      >
        <span className="font-medium">{label}</span>
        <span aria-hidden>:</span>
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronDown aria-hidden className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div
          id={panelId}
          role="group"
          aria-label={label}
          className="absolute left-0 top-full z-50 mt-1 max-h-80 w-max min-w-48 max-w-72 overflow-y-auto rounded-md border border-slate-200 bg-white p-1 shadow-lg"
        >
          <button
            type="button"
            onClick={() => onChange([])}
            disabled={!active}
            className="mb-1 block w-full rounded px-2 py-1 text-left text-xs font-medium text-brand-700 hover:bg-slate-50 disabled:text-slate-400 disabled:hover:bg-transparent"
          >
            {allLabel}
          </button>
          {options.map((option) => (
            <label
              key={option.value}
              className="flex min-h-8 cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-slate-800 hover:bg-slate-50"
            >
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                onChange={() => toggle(option.value)}
                className="size-4 rounded border-slate-300 accent-brand-700"
              />
              <span className="min-w-0 flex-1">{option.label}</span>
              {option.hint !== undefined ? <span className="tabular text-xs text-slate-500">{option.hint}</span> : null}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
