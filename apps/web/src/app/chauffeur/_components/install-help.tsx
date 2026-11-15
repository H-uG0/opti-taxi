"use client";

/**
 * « Installer l'application » (FLD-04): once added to the home screen, the roadmap opens full screen like an app and
 * its shortcuts (manifest) are a long press away. On Android (Chrome, Edge, Samsung Internet) the browser's own prompt
 * (beforeinstallprompt); on an iPhone, which has none, the two steps of Safari's share menu. Hidden once installed
 * (display-mode: standalone), or when the driver says « Plus tard » (remembered on the phone for 30 days).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { Download, Share, X } from "lucide-react";
import { isApplePhone } from "../_lib/nav-apps";

const DISMISS_KEY = "opti-taxi:install-dismissed";
const DISMISS_MS = 30 * 24 * 3600 * 1000;

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

function subscribeDisplay(onChange: () => void): () => void {
  const query = window.matchMedia("(display-mode: standalone)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const standalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const noSubscription = () => () => undefined;
const applePhone = () => isApplePhone(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
const dismissedRecently = () => {
  try {
    return Date.now() - Number(window.localStorage.getItem(DISMISS_KEY) ?? 0) < DISMISS_MS;
  } catch {
    return false;
  }
};

export function InstallHelp() {
  const installed = useSyncExternalStore(subscribeDisplay, standalone, () => true);
  const apple = useSyncExternalStore(noSubscription, applePhone, () => false);
  const recent = useSyncExternalStore(noSubscription, dismissedRecently, () => true);
  const [dismissed, setDismissed] = useState(false);
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);

  useEffect(() => {
    const keep = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    window.addEventListener("beforeinstallprompt", keep);
    return () => window.removeEventListener("beforeinstallprompt", keep);
  }, []);

  if (installed || recent || dismissed || (!apple && !prompt)) return null;
  const later = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // Private browsing: the help comes back next time.
    }
  };
  return (
    <section aria-labelledby="install-title" className="relative space-y-2 rounded-2xl border border-brand-300 bg-brand-50 px-4 py-3 text-brand-950">
      <h2 id="install-title" className="flex items-center gap-2 pr-10 text-base font-semibold text-brand-900">
        <Download aria-hidden className="size-5 shrink-0" />
        Installer la feuille de route
      </h2>
      {apple ? (
        <ol className="list-decimal space-y-1 pl-6 text-sm text-slate-800">
          <li>
            Touchez <Share aria-label="Partager" className="inline size-4 align-text-bottom" /> (Partager) en bas de Safari.
          </li>
          <li>Choisissez «&#x202F;Sur l&apos;écran d&apos;accueil&#x202F;», puis «&#x202F;Ajouter&#x202F;».</li>
        </ol>
      ) : (
        <>
          <p className="text-sm text-slate-800">Elle s&apos;ouvre alors en plein écran depuis l&apos;écran d&apos;accueil, comme une application.</p>
          <button
            type="button"
            onClick={() => {
              void prompt?.prompt();
              void prompt?.userChoice.then(() => setPrompt(null));
            }}
            className="inline-flex min-h-12 w-full touch-manipulation items-center justify-center gap-2 rounded-xl bg-brand-700 px-4 text-base font-semibold text-white hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
          >
            <Download aria-hidden className="size-5" />
            Installer l&apos;application
          </button>
        </>
      )}
      <button
        type="button"
        onClick={later}
        aria-label="Plus tard"
        className="absolute top-1.5 right-1.5 inline-flex size-11 touch-manipulation items-center justify-center rounded-lg text-brand-900 hover:bg-brand-100 focus-visible:outline-2 focus-visible:outline-brand-600"
      >
        <X aria-hidden className="size-5" />
      </button>
    </section>
  );
}
