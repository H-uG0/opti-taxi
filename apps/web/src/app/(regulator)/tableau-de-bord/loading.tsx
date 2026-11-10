import { PageSkeleton } from "@/components/ui/page-skeleton";

/** Shown at once after a click in the menu, while the page's data loads. */
export default function DashboardLoading() {
  return <PageSkeleton label="Chargement du tableau de bord" layout="dashboard" />;
}
