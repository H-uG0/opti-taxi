/** Skeleton shown while a date's planning loads. */
export default function PlanningLoading() {
  const block = "rounded-lg bg-slate-200/70 motion-safe:animate-pulse";
  return (
    <div role="status" aria-label="Chargement du planning" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <div className={`${block}\u00a0h-7 w-80`} />
          <div className={`${block}\u00a0h-4 w-64`} />
        </div>
        <div className={`${block}\u00a0h-10 w-96`} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className={`${block}\u00a0h-20`} />
        ))}
      </div>
      <div className={`${block}\u00a0h-80`} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className={`${block}\u00a0h-96`} />
        <div className={`${block}\u00a0h-96`} />
      </div>
      <span className="sr-only">Chargement du planning…</span>
    </div>
  );
}
