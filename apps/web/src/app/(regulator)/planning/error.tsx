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
      Vérifiez que la base de données est démarrée (port 5433), puis réessayez.
      {digest ? <span className="mt-1 block text-xs text-slate-400">Référence : {digest}</span> : null}
    </EmptyState>
  );
}
