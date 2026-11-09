/**
 * HTTP client of the optimizer service (services/optimizer, FastAPI).
 * Requests and responses are checked against the zod contract; every failure
 * becomes a French message the regulator can act on. With OPTIMIZER_TOKEN set,
 * every call carries it (lib/optimizer/token.ts).
 */
import "server-only";
import type { z } from "zod";
import {
  evaluateRequestSchema,
  healthSchema,
  optimizeRequestSchema,
  planResponseSchema,
  type EvaluateRequest,
  type OptimizeRequest,
  type PlanResponse,
} from "./contract";
import { optimizerHttpErrorMessage } from "./http-errors";
import { optimizerAuthHeaders } from "./token";

const DEFAULT_OPTIMIZER_URL = "http://localhost:8100";
/** Margin added to the solver time limit for the distance matrix, validation and network. */
const RESPONSE_MARGIN_SEC = 30;
const HEALTH_TIMEOUT_MS = 2_500;
/** /evaluate runs no solver (distance matrix, timing, validation): it never needs the solver budget. */
export const EVALUATE_TIMEOUT_MS = 30_000;

/**
 * Why a call failed: the service could not be reached, did not answer in time,
 * or answered with an error (HTTP error, invalid request or response).
 */
export type OptimizerFailureReason = "unreachable" | "timeout" | "error";

export type OptimizerResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      reason?: OptimizerFailureReason;
      /** HTTP status of an error the service answered (absent: no answer, or refused before sending). */
      status?: number;
    };
export type OptimizerHealth = z.infer<typeof healthSchema>;

export function optimizerUrl(): string {
  return (process.env.OPTIMIZER_URL?.trim() || DEFAULT_OPTIMIZER_URL).replace(/\/+$/, "");
}

function unreachableMessage(url: string): string {
  return (
    `Le service d'optimisation ne répond pas (${url}). Lancez-le avec : ` +
    "cd services/optimizer && .venv/Scripts/python.exe -m uvicorn app.main:app --port 8100 " +
    "(ou : docker compose up -d optimizer)."
  );
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(racine)"} : ${issue.message}`)
    .join(" ; ");
}

async function readErrorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return response.statusText;
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object" && "detail" in body) {
      const detail = (body as { detail: unknown }).detail;
      return typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 300);
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.slice(0, 300);
}

async function call<S extends z.ZodType>(
  path: string,
  schema: S,
  init: { method: "GET" | "POST"; body?: unknown; timeoutMs: number },
): Promise<OptimizerResult<z.infer<S>>> {
  const base = optimizerUrl();
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: init.method,
      headers: {
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...optimizerAuthHeaders(),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return {
        ok: false,
        error: `Le service d'optimisation n'a pas répondu en ${Math.round(init.timeoutMs / 1000)} s (${base}). Réessayez ou réduisez le temps de calcul dans les paramètres.`,
        reason: "timeout",
      };
    }
    return { ok: false, error: unreachableMessage(base), reason: "unreachable" };
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    return { ok: false, error: optimizerHttpErrorMessage(response.status, detail), reason: "error", status: response.status };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, error: "Réponse illisible du service d'optimisation (JSON invalide).", reason: "error" };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Réponse inattendue du service d'optimisation (contrat non respecté) : ${formatIssues(parsed.error)}`,
      reason: "error",
    };
  }
  return { ok: true, data: parsed.data };
}

function timeoutFor(timeLimitSec: number): number {
  return (timeLimitSec + RESPONSE_MARGIN_SEC) * 1000;
}

/**
 * POST /optimize: routes of a day. An optimizer older than the routes in place
 * (`initialRoutes`, OPT-08: web redeployed first) refuses that field with a
 * 422: the day is then computed again from scratch, rather than every
 * re-optimization of a planned date failing until the optimizer is redeployed.
 */
export async function optimize(request: OptimizeRequest): Promise<OptimizerResult<PlanResponse>> {
  const body = optimizeRequestSchema.safeParse(request);
  if (!body.success) {
    return { ok: false, error: `Requête d'optimisation invalide : ${formatIssues(body.error)}` };
  }
  const timeoutMs = timeoutFor(body.data.settings.timeLimitSec);
  const result = await call("/optimize", planResponseSchema, { method: "POST", body: body.data, timeoutMs });
  if (result.ok || result.status !== 422 || !body.data.initialRoutes || !result.error.includes("initialRoutes")) {
    return result;
  }
  console.warn("[optimizer] routes in place refused (optimizer older than the web): computed from scratch");
  // JSON.stringify leaves an undefined field out of the body.
  return call("/optimize", planResponseSchema, { method: "POST", body: { ...body.data, initialRoutes: undefined }, timeoutMs });
}

/** POST /evaluate: times, km, revenue and violations of a given plan (no solver: short timeout). */
export async function evaluate(request: EvaluateRequest): Promise<OptimizerResult<PlanResponse>> {
  const body = evaluateRequestSchema.safeParse(request);
  if (!body.success) {
    return { ok: false, error: `Requête d'évaluation invalide : ${formatIssues(body.error)}`, reason: "error" };
  }
  return call("/evaluate", planResponseSchema, {
    method: "POST",
    body: body.data,
    timeoutMs: EVALUATE_TIMEOUT_MS,
  });
}

/** GET /health: is the service up, and which distance source does it use. */
export async function health(): Promise<OptimizerResult<OptimizerHealth>> {
  return call("/health", healthSchema, { method: "GET", timeoutMs: HEALTH_TIMEOUT_MS });
}
