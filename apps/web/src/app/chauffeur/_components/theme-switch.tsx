"use client";

/**
 * « Affichage : Auto · Jour · Nuit » (FLD-04): the choice applies at once to the app's frame (data-theme) and is
 * remembered in a cookie the layout reads (see _lib/theme.ts).
 */
import { useState } from "react";
import { Moon, Sun, SunMoon } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { DRIVER_THEME_LABELS, DRIVER_THEMES, themeCookie, type DriverTheme } from "../_lib/theme";

/** Applies the theme to the app's frame at once and remembers it (the layout draws it from the cookie next time). */
function applyDriverTheme(theme: DriverTheme): void {
  document.cookie = themeCookie(theme);
  for (const frame of document.querySelectorAll<HTMLElement>("[data-driver-frame]")) frame.dataset.theme = theme;
}

const ICONS = { auto: SunMoon, day: Sun, night: Moon } as const;

export function ThemeSwitch({ initial }: { initial: DriverTheme }) {
  const [theme, setTheme] = useState(initial);
  const choose = (next: DriverTheme) => {
    setTheme(next);
    applyDriverTheme(next);
  };
  return (
    <fieldset className="flex items-center justify-center gap-2">
      <legend className="sr-only">Affichage</legend>
      <span aria-hidden className="text-sm text-slate-600">
        Affichage
      </span>
      <div className="inline-flex rounded-xl bg-slate-200 p-1">
        {DRIVER_THEMES.map((value) => {
          const Icon = ICONS[value];
          return (
            <label
              key={value}
              className={cn(
                "inline-flex min-h-11 cursor-pointer touch-manipulation items-center gap-1.5 rounded-lg px-3 text-sm font-semibold has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand-600",
                theme === value ? "bg-white text-brand-800 shadow-sm" : "text-slate-700",
              )}
            >
              <input type="radio" name="driver-theme" value={value} checked={theme === value} onChange={() => choose(value)} className="sr-only" />
              <Icon aria-hidden className="size-4" />
              {DRIVER_THEME_LABELS[value]}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
