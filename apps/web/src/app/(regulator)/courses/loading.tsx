import { PageSkeleton } from "@/components/ui/page-skeleton";

/** Shown at once after a click in the menu, while the page's data loads. */
export default function CoursesLoading() {
  return <PageSkeleton label="Chargement des courses" layout="list" />;
}
