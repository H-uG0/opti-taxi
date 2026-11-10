/**
 * What a regulator page shows while it loads (loading.tsx): its header, then
 * the shape of its content, still when the user asks for reduced motion.
 * Announced once to screen readers (« Chargement des courses… »).
 */
export function PageSkeleton({ label, layout = "list" }: { label: string; layout?: "list" | "dashboard" | "cards" }) {
  const block = "rounded-lg bg-slate-200/70 motion-safe:animate-pulse";
  return (
    <div role="status" aria-label={label} className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <div className={`${block}\u00a0h-7 w-72`} />
          <div className={`${block}\u00a0h-4 w-56`} />
        </div>
        <div className={`${block}\u00a0h-10 w-80`} />
      </div>
      {layout === "dashboard" ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className={`${block}\u00a0h-24`} />
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className={`${block}\u00a0h-56`} />
            ))}
          </div>
        </>
      ) : layout === "cards" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className={`${block}\u00a0h-48`} />
          ))}
        </div>
      ) : (
        <>
          <div className={`${block}\u00a0h-16`} />
          <div className="space-y-2">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className={`${block}\u00a0h-12`} />
            ))}
          </div>
        </>
      )}
      <span className="sr-only">{label}…</span>
    </div>
  );
}
