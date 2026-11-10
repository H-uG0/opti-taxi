"use client";

/**
 * « Déconnexion » of the driver app. Statuses still waiting on the phone are
 * sent only at this account's next sign-in on this phone (and refused if
 * older than 3 h by then): signing out with some left asks first, in the
 * app's own panel (never the browser's dialog), so they are not lost without
 * a word on a phone shared between crews.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { LogOut } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { logout } from "@/app/login/actions";
import { useQueueSnapshot } from "./driver-app";

/** The question asked before signing out with statuses not yet sent. */
export function logoutQuestion(pending: number): string {
  const many = pending > 1;
  return (
    // Non-breaking spaces before « : » and « ? » (French typography).
    `${pending} statut${many ? "s" : ""} pas encore envoyé${many ? "s" : ""} au serveur\u00a0: ` +
    `${many ? "ils partiront" : "il partira"} seulement à votre prochaine connexion sur ce téléphone, ` +
    `s'il${many ? "s ont" : " a"} moins de 3\u00a0h. Se déconnecter quand même\u00a0?`
  );
}

/**
 * Logout keeps its visible label in both layouts. Next to the call button the
 * label goes under the icon, so the header still fits on a 390 px phone.
 */
export function LogoutButton({ stacked }: { stacked: boolean }) {
  const { pending } = useQueueSnapshot();
  const [asking, setAsking] = useState(false);
  // The queue emptied while asking: nothing is left to lose, the question goes. Reset, so the
  // next status queued offline does not bring it back over the roadmap by itself.
  if (asking && pending === 0) setAsking(false);
  const open = asking && pending > 0;
  const trigger = useRef<HTMLButtonElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const questionId = useId();
  // Open: the focus goes to « Rester connecté »; closed (kept, or the queue emptied): back to « Déconnexion ».
  useEffect(() => {
    if (open) stay.current?.focus();
    else if (wasOpen.current) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const keep = () => setAsking(false);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") keep();
  };

  return (
    <form action={logout}>
      <button
        ref={trigger}
        type={pending > 0 ? "button" : "submit"}
        onClick={pending > 0 ? () => setAsking(true) : undefined}
        title="Ferme la session sur tous vos appareils"
        className={cn(
          "inline-flex min-h-11 items-center rounded-lg font-medium text-brand-50 hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white",
          stacked ? "min-w-11 flex-col justify-center gap-1 px-1 text-[11px] leading-none" : "gap-1.5 px-3 text-sm",
        )}
      >
        <LogOut aria-hidden className="size-4" />
        Déconnexion
      </button>
      {open ? (
        // Over the roadmap, thumb-sized buttons; staying is the first choice.
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-describedby={questionId}
            aria-label="Se déconnecter avec des statuts non envoyés"
            onKeyDown={onKeyDown}
            className="w-full max-w-lg space-y-4 rounded-2xl bg-white p-4 text-slate-900 shadow-xl"
          >
            <p id={questionId} className="text-base">
              {logoutQuestion(pending)}
            </p>
            <div className="grid gap-2">
              <button
                ref={stay}
                type="button"
                onClick={keep}
                className="min-h-12 rounded-xl border border-slate-300 bg-white px-4 text-base font-semibold text-slate-900 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
              >
                Rester connecté
              </button>
              <button
                type="submit"
                className="min-h-12 rounded-xl bg-red-700 px-4 text-base font-semibold text-white focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-red-700"
              >
                Oui, se déconnecter
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}
