import { Phone } from "lucide-react";
import { cn } from "@/components/ui/cn";
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
 * « Appeler la régulation » under a message that asks for it (patient absent
 * on the outbound leg, no route): a full-width button of at least 48 px, easy
 * to hit in a moving vehicle, with the number written. Nothing when no number
 * is set in Paramètres (the message then says it in words).
 */
export function RegulatorCallBlock({ regulator, className }: { regulator: RegulatorContact | null; className?: string }) {
  if (!regulator) return null;
  return (
    <a
      href={regulator.href}
      className={cn(
        "flex min-h-12 w-full touch-manipulation items-center justify-center gap-2 rounded-xl bg-brand-700 px-4 py-2 text-base font-semibold text-white shadow-sm hover:bg-brand-800 active:bg-brand-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
        className,
      )}
    >
      <Phone aria-hidden className="size-5 shrink-0" />
      <span className="flex flex-col items-start leading-tight">
        <span>Appeler la régulation</span>
        <span className="tabular text-sm font-medium whitespace-nowrap text-brand-100">{regulator.number}</span>
      </span>
    </a>
  );
}
