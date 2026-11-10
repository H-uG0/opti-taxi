"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/layout";

/**
 * A regulator page that failed to load: shown inside the layout, so the menu
 * stays and the dispatcher can go on elsewhere (the root error page replaces everything).
 */
export default function RegulatorError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const digest = error instanceof Error && "digest" in error ? String((error as Error & { digest?: string }).digest ?? "") : "";

  return (
    <EmptyState
      title="Cette page n'a pas pu être chargée"
      action={
        <Button onClick={() => retry()} variant="primary">
          Réessayer
        </Button>
      }
    >
      Réessayez dans un instant, ou continuez depuis le menu. Si le problème continue, prévenez la personne qui gère
      l&apos;application{digest ? " en lui donnant la référence ci-dessous" : ""}.
      {process.env.NODE_ENV === "development" ? (
        <span className="mt-2 block text-xs text-slate-500">
          En développement : vérifiez que la base de données est démarrée (port 5433).
        </span>
      ) : null}
      {digest ? <span className="mt-1 block text-xs text-slate-500">Référence : {digest}</span> : null}
    </EmptyState>
  );
}
