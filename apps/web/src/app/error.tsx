"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/layout";

/**
 * Last-resort error page of every route without an error.tsx of its own
 * (regulator layout and pages, login, roadmap layout). Props as documented in
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md
 * (Next.js 16.3+: `retry` re-fetches and re-renders the segment).
 * In production a server error reaches the browser without its message: only
 * the digest, which matches the server log.
 */
export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const digest = error instanceof Error && "digest" in error ? String((error as Error & { digest?: string }).digest ?? "") : "";

  return (
    <main className="mx-auto w-full max-w-lg px-4 py-16">
      <EmptyState
        title="La page n'a pas pu être chargée"
        action={
          <Button onClick={() => retry()} variant="primary">
            Réessayer
          </Button>
        }
      >
        Réessayez dans un instant. Si le problème continue, prévenez la personne qui gère l&apos;application.
        {process.env.NODE_ENV === "development" ? (
          <span className="mt-2 block text-xs text-slate-500">
            En développement : vérifiez que la base de données est démarrée (port 5433).
          </span>
        ) : null}
        {digest ? <span className="mt-1 block text-xs text-slate-500">Référence : {digest}</span> : null}
      </EmptyState>
    </main>
  );
}
