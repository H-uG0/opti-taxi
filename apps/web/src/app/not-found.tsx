import type { Metadata } from "next";
import { LinkButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/layout";

export const metadata: Metadata = { title: "Page introuvable" };

/**
 * Unknown URL, or a record that no longer exists (notFound() in a page).
 * "/" sends each role to its home page.
 */
export default function NotFound() {
  return (
    <main className="mx-auto w-full max-w-lg px-4 py-16">
      <EmptyState
        title="Page introuvable"
        action={
          <LinkButton href="/" variant="primary">
            Retour à l&apos;accueil
          </LinkButton>
        }
      >
        Cette adresse ne correspond à aucune page, ou l&apos;enregistrement a été supprimé.
      </EmptyState>
    </main>
  );
}
