/** Command-line options of `pnpm db:history`. Pure, unit-tested. */
import { HistoryError } from "./errors";

export type HistoryOptions = {
  /** Working days simulated before today. */
  days: number;
  /** Solver time limit per optimization (s); null = the one the app would send (settings). */
  budgetSec: number | null;
  help: boolean;
};

export const DEFAULT_HISTORY_DAYS = 20;
const MAX_HISTORY_DAYS = 60;
/** Upper bound of settings.timeLimitSec in the optimizer contract. */
const MAX_BUDGET_SEC = 600;

export const HISTORY_USAGE = [
  "Usage : pnpm db:history [--days N] [--budget S]",
  `  --days N     jours ouvrés simulés avant aujourd'hui (défaut ${DEFAULT_HISTORY_DAYS}, maximum ${MAX_HISTORY_DAYS})`,
  "  --budget S   temps de calcul de l'optimiseur par optimisation, en secondes",
  "               (défaut : celui des paramètres, comme dans l'application)",
].join("\n");

function integerOption(name: string, raw: string | undefined, min: number, max: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    throw new HistoryError(`L'option --${name} attend un nombre entier.\n${HISTORY_USAGE}`);
  }
  const value = Number(raw.trim());
  if (value < min || value > max) {
    throw new HistoryError(`L'option --${name} doit être comprise entre ${min} et ${max} (reçu : ${value}).`);
  }
  return value;
}

/** `--days 5`, `--days=5`, `--budget 3`, `--help`; a bare `--` (forwarded by pnpm) is ignored. */
export function parseHistoryArgs(argv: readonly string[]): HistoryOptions {
  const options: HistoryOptions = { days: DEFAULT_HISTORY_DAYS, budgetSec: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") continue;
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    const match = /^--(days|budget)(?:=(.*))?$/.exec(arg);
    if (!match) throw new HistoryError(`Option inconnue : « ${arg} ».\n${HISTORY_USAGE}`);
    const name = match[1] as "days" | "budget";
    const raw = match[2] ?? argv[++i];
    if (name === "days") options.days = integerOption(name, raw, 1, MAX_HISTORY_DAYS);
    else options.budgetSec = integerOption(name, raw, 1, MAX_BUDGET_SEC);
  }
  return options;
}
