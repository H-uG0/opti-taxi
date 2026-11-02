import type { ReactNode } from "react";
import { Phone } from "lucide-react";
import type { RegulatorContact } from "../_lib/links";

/**
 * Header button: one tap calls the regulation, wherever the driver is on the
 * roadmap. The number is written under the label so it can also be dialled
 * from another phone; only the narrowest screens (< 380 px) drop it, and the
 * full « Appeler la régulation » only fits from 480 px.
 */
export function RegulatorCallButton({ regulator }: { regulator: RegulatorContact }) {
  return (
    <a
      href={regulator.href}
      aria-label={`Appeler la régulation, ${regulator.number}`}
      className="inline-flex min-h-11 touch-manipulation items-center gap-2 rounded-lg bg-white py-1 pr-3 pl-2.5 text-brand-900 hover:bg-brand-50 active:bg-brand-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
    >
      <Phone aria-hidden className="size-4 shrink-0" />
      <span className="flex flex-col items-start">
        <span className="text-sm leading-4 font-bold">
          <span className="min-[480px]:hidden">Régulation</span>
          <span className="hidden min-[480px]:inline">Appeler la régulation</span>
        </span>
        <span className="tabular hidden text-xs leading-4 font-medium whitespace-nowrap text-brand-700 min-[380px]:block">
          {regulator.number}
        </span>
      </span>
    </a>
  );
}

/**
 * « appelez la régulation » inside a sentence: a tel: link followed by the
 * number when one is set in Paramètres, the plain words otherwise.
 */
export function CallRegulator({ regulator, children }: { regulator: RegulatorContact | null; children: ReactNode }) {
  if (!regulator) return <>{children}</>;
  return (
    <a
      href={regulator.href}
      className="touch-manipulation rounded-sm py-1.5 font-semibold underline decoration-2 underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
    >
      {children} au <span className="tabular whitespace-nowrap">{regulator.number}</span>
    </a>
  );
}
