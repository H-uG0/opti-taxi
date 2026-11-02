/** Skeleton while the roadmap of another day loads. */
export default function DriverRoadmapLoading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <p role="status" className="sr-only">
        Chargement de la feuille de route…
      </p>
      <div className="h-13 animate-pulse rounded-2xl bg-slate-200" />
      <div className="h-7 w-2/3 animate-pulse rounded-lg bg-slate-200" />
      <div className="h-44 animate-pulse rounded-2xl bg-slate-200" />
      <div className="h-56 animate-pulse rounded-2xl bg-slate-200" />
      <div className="h-56 animate-pulse rounded-2xl bg-slate-200" />
    </div>
  );
}
