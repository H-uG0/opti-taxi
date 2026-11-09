import { Phone } from "lucide-react";

/** A number to call from the roadmap: a large target with the number written (it can be dialled from another phone). */
export function PhoneLink({ href, label, number }: { href: string; label: string; number: string }) {
  return (
    <a
      href={href}
      className="flex min-h-12 touch-manipulation items-center gap-3 rounded-xl border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-50 active:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
    >
      <Phone aria-hidden className="size-5 shrink-0 text-brand-700" />
      <span className="min-w-0">
        <span className="block text-xs font-medium text-slate-600">{label}</span>
        <span className="tabular block truncate text-base font-semibold text-slate-900">{number}</span>
      </span>
    </a>
  );
}
