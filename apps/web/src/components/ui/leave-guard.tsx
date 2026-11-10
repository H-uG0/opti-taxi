"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "./button";

/**
 * Unsaved changes on screen (Équipages): leaving the page or its date asks
 * first, in the application's own dialog (never the browser's confirm). A
 * link of the application (menu, « Jour suivant ») and the date field of
 * DayNav ask through it; closing or reloading the tab gets the browser's
 * own question (beforeunload: the only one a page may show then). A link to
 * the same page and date (a filter, an anchor) is not a departure: the form
 * stays mounted and keeps the changes.
 */
let pending: string | null = null;
let ask: ((message: string) => Promise<boolean>) | null = null;

/** Resolves true when nothing is pending or the user agrees to lose it (« Quitter sans enregistrer »). */
export function requestLeave(): Promise<boolean> {
  if (pending === null || ask === null) return Promise.resolve(true);
  return ask(pending);
}

/** The address leaves the page shown: another path, or the same path for another date. */
export function leavesPage(target: URL, current: URL): boolean {
  if (target.origin !== current.origin) return false;
  return target.pathname !== current.pathname || target.searchParams.get("date") !== current.searchParams.get("date");
}

type Question = { message: string; resolve: (leave: boolean) => void; returnTo: HTMLElement | null };

/** Render once in the form that holds the changes; `message` null when nothing is unsaved. */
export function LeaveGuard({ message }: { message: string | null }) {
  const [question, setQuestion] = useState<Question | null>(null);
  const titleId = useId();
  const textId = useId();
  const stay = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (message === null) return;
    pending = message;
    const open = (text: string) =>
      new Promise<boolean>((resolve) => {
        const active = document.activeElement;
        setQuestion({ message: text, resolve, returnTo: active instanceof HTMLElement ? active : null });
      });
    ask = open;
    const onUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    // On window, in the capture phase: before Next.js's <Link> handler, which navigates on the client.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      if (!leavesPage(new URL(link.href, window.location.href), new URL(window.location.href))) return;
      event.preventDefault();
      event.stopPropagation();
      void open(message).then((leave) => {
        if (!leave) return;
        // Agreed: a full page load, which does not ask a second time.
        window.removeEventListener("beforeunload", onUnload);
        window.location.assign(link.href);
      });
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("click", onClick, true);
    return () => {
      if (pending === message) pending = null;
      if (ask === open) ask = null;
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("click", onClick, true);
    };
  }, [message]);

  useEffect(() => {
    if (question) stay.current?.focus();
  }, [question]);

  if (!question) return null;

  const answer = (leave: boolean) => {
    setQuestion(null);
    if (!leave) question.returnTo?.focus();
    question.resolve(leave);
  };
  // A modal: Échap stays, Tab goes round its two buttons.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      answer(false);
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const first = buttons[0];
    const last = buttons.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-slate-900/40 p-4">
      <div
        ref={panel}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        onKeyDown={onKeyDown}
        className="w-full max-w-md space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-xl"
      >
        <h2 id={titleId} className="text-base font-semibold text-slate-900">
          Modifications non enregistrées
        </h2>
        <p id={textId} className="text-sm text-slate-700">
          {question.message}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button ref={stay} variant="secondary" size="sm" onClick={() => answer(false)}>
            Rester sur la page
          </Button>
          <Button variant="danger" size="sm" onClick={() => answer(true)}>
            Quitter sans enregistrer
          </Button>
        </div>
      </div>
    </div>
  );
}
