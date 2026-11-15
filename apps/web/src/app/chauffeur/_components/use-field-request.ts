"use client";

/**
 * Sends one request or signal of a stop (POST /api/chauffeur/stops/:id/requests): DAY-05's end of session, return,
 * cancellation and next session, FLD-01's lateness and « Patient pas prêt ». Online only (no queue): without network
 * nothing leaves and the crew is told so. The roadmap is refreshed after an answer that changed it.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { FieldRequestResponse } from "@/app/api/chauffeur/stops/[id]/requests/route";
import type { FieldCancelReason, LateSignalMinutes } from "@/lib/domain/field-requests";
import { serverReachable } from "../_lib/reachability";
import { useDriverApp } from "./driver-app";

export type FieldRequestBody = {
  kind: "READY_TIME" | "CANCEL" | "RETURN" | "NEXT_SESSION" | "LATE" | "NOT_READY";
  readyMinute?: number;
  reason?: FieldCancelReason;
  nextSessionDate?: string;
  target?: "return";
  lateMinutes?: LateSignalMinutes;
};

export const OFFLINE_REQUEST_ERROR = "Pas de réseau : rien n'a été envoyé. Réessayez, ou appelez la régulation.";

export function useFieldRequest(stopId: string) {
  const router = useRouter();
  const { ownerId } = useDriverApp();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [, startTransition] = useTransition();

  const send = async (body: FieldRequestBody) => {
    setBusy(true);
    setMessage(null);
    try {
      if (navigator.onLine === false) throw new Error("offline");
      const response = await fetch(`/api/chauffeur/stops/${encodeURIComponent(stopId)}/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, ownerId }),
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
      const answer = (await response.json().catch(() => null)) as FieldRequestResponse | null;
      if (!answer) throw new Error("unreadable");
      setMessage(answer.ok ? { ok: true, text: answer.message } : { ok: false, text: answer.error });
      if (answer.ok || answer.code === "conflict") {
        if (await serverReachable()) startTransition(() => router.refresh());
      }
    } catch {
      setMessage({ ok: false, text: OFFLINE_REQUEST_ERROR });
    } finally {
      setBusy(false);
    }
  };

  return { busy, message, send };
}
