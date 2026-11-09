"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, LoaderCircle, RefreshCw, X, CircleX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { PlanningActionResult } from "./actions";

type Activity = { label: string; startedAt: number; expectedSec: number | null };
type Feedback = { tone: "success" | "error"; text: string; reload?: boolean };

type RunOptions = {
  /** Long action (optimizer call): show elapsed time against the solver time limit. */
  long?: boolean;
  onResult?: (result: PlanningActionResult) => void;
};

type ActivityContext = {
  busy: boolean;
  run: (label: string, task: () => Promise<PlanningActionResult>, options?: RunOptions) => void;
  /**
   * Whether a computation of the date runs, as last polled by
   * PlanningVersionWatcher; null before any poll (the page's own render tells).
   */
  remoteRunning: boolean | null;
  setRemoteRunning: (running: boolean | null) => void;
  /** Why the optimizer cannot be called (OptimizerStatus), null when it answered. */
  optimizerOffline: string | null;
  setOptimizerOffline: (reason: string | null) => void;
};

const Context = createContext<ActivityContext | null>(null);

export function usePlanningActivity(): ActivityContext {
  const value = useContext(Context);
  if (!value) throw new Error("usePlanningActivity must be used inside <PlanningActivityProvider>");
  return value;
}

const FeedbackContext = createContext<{
  activity: Activity | null;
  feedback: Feedback | null;
  dismiss: () => void;
}>({ activity: null, feedback: null, dismiss: () => {} });

/**
 * Runs the planning server actions one at a time and shares their progress:
 * every button is disabled while an action runs, and <PlanningActivityBanner>
 * shows "Optimisation en cours…" then the result.
 */
export function PlanningActivityProvider({ timeLimitSec, children }: { timeLimitSec: number; children: ReactNode }) {
  const [isPending, startTransition] = useTransition();
  const [activity, setActivity] = useState<Activity | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [remoteRunning, setRemoteRunning] = useState<boolean | null>(null);
  const [optimizerOffline, setOptimizerOffline] = useState<string | null>(null);

  const run = useCallback<ActivityContext["run"]>(
    (label, task, options) => {
      setFeedback(null);
      setActivity({ label, startedAt: Date.now(), expectedSec: options?.long ? timeLimitSec : null });
      startTransition(async () => {
        try {
          const result: PlanningActionResult | undefined = await task();
          // A redirect (expired session) resolves without a result: the router navigates.
          if (!result) return;
          if (result.ok) setFeedback({ tone: "success", text: result.message });
          else if (!result.needsConfirmation) setFeedback({ tone: "error", text: result.error, reload: result.stale === true });
          options?.onResult?.(result);
        } catch {
          setFeedback({
            tone: "error",
            text: "L'action n'a pas abouti (connexion au serveur perdue ?). Rechargez la page pour voir l'état réel du planning.",
          });
        } finally {
          setActivity(null);
        }
      });
    },
    [timeLimitSec],
  );

  const busy = isPending || activity !== null;
  const actions = useMemo(
    () => ({ busy, run, remoteRunning, setRemoteRunning, optimizerOffline, setOptimizerOffline }),
    [busy, run, remoteRunning, optimizerOffline],
  );
  const status = useMemo(() => ({ activity, feedback, dismiss: () => setFeedback(null) }), [activity, feedback]);

  return (
    <Context.Provider value={actions}>
      <FeedbackContext.Provider value={status}>{children}</FeedbackContext.Provider>
    </Context.Provider>
  );
}

function Elapsed({ startedAt, expectedSec }: { startedAt: number; expectedSec: number | null }) {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  // The solver uses its whole time budget; matrix and saving add a few seconds.
  const expected = expectedSec !== null ? expectedSec + 5 : null;
  const progress = expected ? Math.min(0.97, seconds / expected) : null;
  return (
    <>
      <span className="tabular text-brand-700">
        {seconds} s{expected ? ` / ~${expected} s` : null}
      </span>
      {progress !== null ? (
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden rounded-b-lg bg-brand-100">
          <span className="block h-full bg-brand-600 transition-[width] duration-500" style={{ width: `${progress * 100}%` }} />
        </span>
      ) : null}
    </>
  );
}

/** Progress of the running action, then its result. */
export function PlanningActivityBanner({ className }: { className?: string }) {
  const { activity, feedback, dismiss } = useContext(FeedbackContext);
  const router = useRouter();

  if (activity) {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "relative flex items-center gap-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-900",
          className,
        )}
      >
        <LoaderCircle aria-hidden className="size-4 shrink-0 motion-safe:animate-spin" />
        <span className="font-medium">{activity.label}</span>
        <Elapsed startedAt={activity.startedAt} expectedSec={activity.expectedSec} />
        {activity.expectedSec !== null ? (
          <span className="hidden text-brand-800/80 md:inline">
            Le solveur explore les combinaisons pendant {activity.expectedSec} s au plus ; vous pouvez rester sur la page.
          </span>
        ) : null}
      </div>
    );
  }

  if (!feedback) return <div role="status" aria-live="polite" className="sr-only" />;
  const success = feedback.tone === "success";
  const Icon = success ? CircleCheck : CircleX;
  return (
    <div
      role={success ? "status" : "alert"}
      className={cn(
        "flex items-start gap-3 rounded-lg border px-4 py-3 text-sm",
        success ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900",
        className,
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 flex-1 break-words">{feedback.text}</p>
      {feedback.reload ? (
        <Button
          size="sm"
          variant="secondary"
          className="-my-1"
          onClick={() => {
            dismiss();
            router.refresh();
          }}
        >
          <RefreshCw aria-hidden className="size-3.5" />
          Recharger
        </Button>
      ) : null}
      <button
        type="button"
        onClick={dismiss}
        className="-m-1 rounded p-1 hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-brand-600"
        aria-label="Fermer le message"
      >
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
}

/** True while the banner shows an action refused on a stale page (it offers « Recharger » itself). */
export function useStaleFeedback(): boolean {
  return useContext(FeedbackContext).feedback?.reload === true;
}
