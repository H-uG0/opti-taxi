/**
 * HTTP client of the optimizer service (services/optimizer, FastAPI).
 * Requests and responses are checked against the zod contract; every failure
 * becomes a French message the regulator can act on.
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

const DEFAULT_OPTIMIZER_URL = "http://localhost:8100";
/** Margin added to the solver time limit for the distance matrix, validation and network. */
const RESPONSE_MARGIN_SEC = 30;
const HEALTH_TIMEOUT_MS = 2_500;

export type OptimizerResult<T> = { ok: true; data: T } | { ok: false; error: string };
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
      headers: init.body === undefined ? { accept: "application/json" } : { "content-type": "application/json", accept: "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return {
        ok: false,
        error: `Le service d'optimisation n'a pas répondu en ${Math.round(init.timeoutMs / 1000)} s (${base}). Réessayez ou réduisez le temps de calcul dans les paramètres.`,
      };
    }
    return { ok: false, error: unreachableMessage(base) };
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    return {
      ok: false,
      error: `Le service d'optimisation a renvoyé une erreur (HTTP ${response.status}) : ${detail}`,
    };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, error: "Réponse illisible du service d'optimisation (JSON invalide)." };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Réponse inattendue du service d'optimisation (contrat non respecté) : ${formatIssues(parsed.error)}`,
    };
  }
  return { ok: true, data: parsed.data };
}

function timeoutFor(timeLimitSec: number): number {
  return (timeLimitSec + RESPONSE_MARGIN_SEC) * 1000;
}

/** POST /optimize: routes of a day. */
export async function optimize(request: OptimizeRequest): Promise<OptimizerResult<PlanResponse>> {
  const body = optimizeRequestSchema.safeParse(request);
  if (!body.success) {
    return { ok: false, error: `Requête d'optimisation invalide : ${formatIssues(body.error)}` };
  }
  return call("/optimize", planResponseSchema, {
    method: "POST",
    body: body.data,
    timeoutMs: timeoutFor(body.data.settings.timeLimitSec),
  });
}

/** POST /evaluate: times, km, revenue and violations of a given plan. */
export async function evaluate(request: EvaluateRequest): Promise<OptimizerResult<PlanResponse>> {
  const body = evaluateRequestSchema.safeParse(request);
  if (!body.success) {
    return { ok: false, error: `Requête d'évaluation invalide : ${formatIssues(body.error)}` };
  }
  return call("/evaluate", planResponseSchema, {
    method: "POST",
    body: body.data,
    timeoutMs: timeoutFor(body.data.settings.timeLimitSec),
  });
}

/** GET /health: is the service up, and which distance source does it use. */
export async function health(): Promise<OptimizerResult<OptimizerHealth>> {
  return call("/health", healthSchema, { method: "GET", timeoutMs: HEALTH_TIMEOUT_MS });
}
