"use client";

import "./globals.css";
import RootError from "./error";

/**
 * Error in the root layout itself: replaces it, so it brings its own <html>,
 * <body> and styles (node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/error.md, "Global Error"). No `metadata` export in an
 * error boundary: React's <title> instead.
 */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="fr">
      <body className="min-h-dvh">
        <title>Erreur · Opti-Taxi</title>
        <RootError error={error} retry={retry} />
      </body>
    </html>
  );
}
