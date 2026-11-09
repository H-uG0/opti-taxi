/**
 * Optimizer calls of the history script. lib/optimizer/client.ts is
 * server-only (Next.js): this is the same HTTP exchange, checked against the
 * same zod contract and with the same OPTIMIZER_TOKEN header, for a
 * command-line script. `fetch` is a parameter so the error handling is
 * unit-tested without a running service. A solve refused because the service
 * is busy (429: a regulator optimizing at the same time, e.g. on the demo
 * while the history loads in the background) is retried after a pause.
 */
import type { z } from "zod";
import {
  evaluateRequestSchema,
  healthSchema,
  optimizeRequestSchema,
  planResponseSchema,
  type EvaluateRequest,
  type OptimizeRequest,
  type PlanResponse,
} from "@/lib/optimizer/contract";
import { optimizerHttpErrorMessage } from "@/lib/optimizer/http-errors";
import { optimizerAuthHeaders } from "@/lib/optimizer/token";
import { HistoryError } from "./errors";

const DEFAULT_OPTIMIZER_URL = "http://localhost:8100";
/** Generous: the first request of a cold service on a slow machine takes several seconds. */
const HEALTH_TIMEOUT_MS = 15_000;
/** Margin added to the solver time limit for the distance matrix, validation and network. */
const RESPONSE_MARGIN_SEC = 60;
/** A busy service (429) is asked again this many times, BUSY_PAUSE_MS apart (5 min in all). */
export const BUSY_RETRIES = 20;
const BUSY_PAUSE_MS = 15_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type OptimizerClientOptions = {
  /** Authorization header (OPTIMIZER_TOKEN); read from the environment by default. */
  authHeaders?: Record<string, string>;
  /** Pause before asking a busy service again (tests: no wait). */
  pause?: (ms: number) => Promise<void>;
};

/** Same reasons as lib/optimizer/client.ts (OptimizerFailureReason): refreshRoutes tells « unavailable » from « failed » with them. */
export type OptimizerFailureReason = "unreachable" | "timeout" | "error";

/** A failed optimizer call: French message for the console, reason for the callers that need it. */
export class OptimizerCallError extends HistoryError {
  constructor(
    message: string,
    readonly reason: OptimizerFailureReason,
  ) {
    super(message);
    this.name = "OptimizerCallError";
  }
}

/** Same shape as the app's evaluate() result (refresh-routes.ts never wants an exception). */
export type EvaluateOutcome =
  | { ok: true; data: PlanResponse }
  | { ok: false; error: string; reason: OptimizerFailureReason };

export type OptimizerClient = {
  baseUrl: string;
  /** GET /health; throws HistoryError when the service does not answer. */
  health: () => Promise<{ matrixSource: string }>;
  /** POST /optimize; throws HistoryError on any failure. */
  optimize: (request: OptimizeRequest) => Promise<PlanResponse>;
  /** POST /evaluate; never throws. */
  evaluate: (request: EvaluateRequest) => Promise<EvaluateOutcome>;
};

/** The request with another solver time limit (--budget), or unchanged when `timeLimitSec` is null. */
export function withTimeLimit(request: OptimizeRequest, timeLimitSec: number | null): OptimizeRequest {
  if (timeLimitSec === null) return request;
  return { ...request, settings: { ...request.settings, timeLimitSec } };
}

export function optimizerBaseUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return (env.OPTIMIZER_URL?.trim() || DEFAULT_OPTIMIZER_URL).replace(/\/+$/, "");
}

/** Port of the optimizer URL ("8199" for http://localhost:8199), the scheme's default when the URL names none. */
export function optimizerPort(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch {
    return new URL(DEFAULT_OPTIMIZER_URL).port;
  }
}

export function unreachableMessage(url: string): string {
  return (
    `Le service d'optimisation ne répond pas (${url}). Démarrez-le : docker compose up -d optimizer, ` +
    `ou depuis services/optimizer, dans son environnement virtuel : uvicorn app.main:app --port ${optimizerPort(url)} ` +
    "(voir services/optimizer/README.md). Vérifiez aussi OPTIMIZER_URL, puis relancez pnpm db:history."
  );
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(racine)"} : ${issue.message}`)
    .join(" ; ");
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return response.statusText;
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object" && "detail" in body) {
      const detail = (body as { detail: unknown }).detail;
      return typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 300);
    }
  } catch {
    // Not JSON: the raw text.
  }
  return text.slice(0, 300);
}

export function createOptimizerClient(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
  options: OptimizerClientOptions = {},
): OptimizerClient {
  const authHeaders = options.authHeaders ?? optimizerAuthHeaders();
  const pause = options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function send(path: string, init: { method: "GET" | "POST"; body?: unknown; timeoutMs: number }): Promise<Response> {
    return fetchImpl(`${baseUrl}${path}`, {
      method: init.method,
      headers: {
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...authHeaders,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  }

  async function call<S extends z.ZodType>(
    path: string,
    schema: S,
    init: { method: "GET" | "POST"; body?: unknown; timeoutMs: number; retryWhenBusy?: boolean },
  ): Promise<z.infer<S>> {
    let response: Response;
    try {
      response = await send(path, init);
      for (let retry = 0; init.retryWhenBusy && response.status === 429 && retry < BUSY_RETRIES; retry++) {
        await response.body?.cancel();
        await pause(BUSY_PAUSE_MS);
        response = await send(path, init);
      }
    } catch (error) {
      if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new OptimizerCallError(
          `Le service d'optimisation n'a pas répondu en ${Math.round(init.timeoutMs / 1000)} s (${baseUrl}). ` +
            "Relancez avec un --budget plus petit ou vérifiez le service.",
          "timeout",
        );
      }
      throw new OptimizerCallError(unreachableMessage(baseUrl), "unreachable");
    }
    if (!response.ok) {
      throw new OptimizerCallError(optimizerHttpErrorMessage(response.status, await errorDetail(response)), "error");
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new OptimizerCallError("Réponse illisible du service d'optimisation (JSON invalide).", "error");
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new OptimizerCallError(
        `Réponse inattendue du service d'optimisation (contrat non respecté) : ${formatIssues(parsed.error)}`,
        "error",
      );
    }
    return parsed.data;
  }

  const timeoutFor = (timeLimitSec: number) => (timeLimitSec + RESPONSE_MARGIN_SEC) * 1000;

  return {
    baseUrl,
    async health() {
      const body = await call("/health", healthSchema, { method: "GET", timeoutMs: HEALTH_TIMEOUT_MS });
      return { matrixSource: body.matrixSource };
    },
    async optimize(request) {
      const body = optimizeRequestSchema.safeParse(request);
      if (!body.success) throw new HistoryError(`Requête d'optimisation invalide : ${formatIssues(body.error)}`);
      return call("/optimize", planResponseSchema, {
        method: "POST",
        body: body.data,
        timeoutMs: timeoutFor(body.data.settings.timeLimitSec),
        retryWhenBusy: true,
      });
    },
    async evaluate(request) {
      const body = evaluateRequestSchema.safeParse(request);
      if (!body.success) {
        return { ok: false, error: `Requête d'évaluation invalide : ${formatIssues(body.error)}`, reason: "error" };
      }
      try {
        const data = await call("/evaluate", planResponseSchema, {
          method: "POST",
          body: body.data,
          timeoutMs: timeoutFor(body.data.settings.timeLimitSec),
        });
        return { ok: true, data };
      } catch (error) {
        const reason = error instanceof OptimizerCallError ? error.reason : "error";
        return { ok: false, error: error instanceof Error ? error.message : String(error), reason };
      }
    },
  };
}
