"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/layout";

export default function PlanningError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const digest = error instanceof Error && "digest" in error ? String((error as Error & { digest?: string }).digest ?? "") : "";

  return (
    <EmptyState
      title="Le planning n'a pas pu être chargé"
      action={
        <Button onClick={() => retry()} variant="primary">
          Réessayer
        </Button>
      }
    >
      Réessayez dans un instant. Si le problème continue, prévenez la personne qui gère l&apos;application
      {digest ? " en lui donnant la référence ci-dessous" : ""}.
      {process.env.NODE_ENV === "development" ? (
        <span className="mt-2 block text-xs text-slate-500">
          En développement&nbsp;: vérifiez que la base de données est démarrée (port 5433).
        </span>
      ) : null}
      {digest ? <span className="mt-1 block text-xs text-slate-500">Référence&nbsp;: {digest}</span> : null}
    </EmptyState>
  );
}
