"use client";

/**
 * « Déconnexion » of the driver app. Statuses still waiting on the phone are
 * sent only at this account's next sign-in on this phone (and refused if
 * older than 3 h by then): signing out with some left asks first, so they
 * are not lost without a word on a phone shared between crews.
 */
import { LogOut } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { logout } from "@/app/login/actions";
import { useQueueSnapshot } from "./driver-app";

/** The question asked before signing out with statuses not yet sent. */
export function logoutQuestion(pending: number): string {
  const many = pending > 1;
  return (
    // Non-breaking spaces before « : » and « ? » (French typography; the native dialog wraps lines).
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
  return (
    <form
      action={logout}
      onSubmit={(event) => {
        if (pending > 0 && !window.confirm(logoutQuestion(pending))) event.preventDefault();
      }}
    >
      <button
        type="submit"
        title="Ferme la session sur tous vos appareils"
        className={cn(
          "inline-flex min-h-11 items-center rounded-lg font-medium text-brand-50 hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white",
          stacked ? "min-w-11 flex-col justify-center gap-1 px-1 text-[11px] leading-none" : "gap-1.5 px-3 text-sm",
        )}
      >
        <LogOut aria-hidden className="size-4" />
        Déconnexion
      </button>
    </form>
  );
}
