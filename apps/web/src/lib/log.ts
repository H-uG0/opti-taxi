/**
 * Server error logging that never writes health data. Prisma errors print the
 * whole query invocation in `message` (addresses, notes, patient ids), and
 * server logs sit outside the database's HDS controls, so for those only the
 * error class, the Prisma code and the constraint target are kept. Callers add
 * the record ids they need to investigate.
 *
 * Pure module (console only): unit-tested.
 */

export type LogIds = Record<string, string | number | boolean | null | undefined>;

/**
 * The "    at …" frames of a stack, never its first lines: those repeat the
 * message, which for a Prisma error spans several lines of query arguments.
 */
function stackFrames(error: Error): string | undefined {
  const frames = error.stack
    ?.split("\n")
    .filter((line) => /^\s+at /.test(line))
    .slice(0, 8);
  return frames && frames.length > 0 ? frames.join("\n") : undefined;
}

/** Fields of `error` that are safe to log. */
export function safeErrorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: typeof error };
  const fields: Record<string, unknown> = { name: error.name };
  const prismaLike = error as { code?: unknown; meta?: { target?: unknown; modelName?: unknown } };
  const stack = stackFrames(error);
  if (error.name.startsWith("Prisma") || (typeof prismaLike.code === "string" && /^P\d{4}$/.test(prismaLike.code))) {
    if (typeof prismaLike.code === "string") fields.code = prismaLike.code;
    if (prismaLike.meta?.target !== undefined) fields.target = prismaLike.meta.target;
    if (typeof prismaLike.meta?.modelName === "string") fields.model = prismaLike.meta.modelName;
    if (stack) fields.stack = stack;
    return fields;
  }
  fields.message = error.message.slice(0, 500);
  if (stack) fields.stack = stack;
  if (error.cause instanceof Error) fields.cause = safeErrorFields(error.cause);
  return fields;
}

function isPrismaError(value: unknown): boolean {
  return value instanceof Error && value.name.startsWith("PrismaClient");
}

/**
 * Arguments of a console call with every Prisma error (or error caused by one)
 * replaced by its safe fields. Next.js logs uncaught errors of pages and
 * server actions with console.error(error) itself, so instrumentation.ts runs
 * console.error through this. Other arguments are passed through unchanged.
 */
export function redactConsoleArgs(args: readonly unknown[]): unknown[] {
  return args.map((arg) => {
    if (!(arg instanceof Error)) return arg;
    if (!isPrismaError(arg) && !isPrismaError(arg.cause)) return arg;
    const digest = (arg as { digest?: unknown }).digest;
    return { ...safeErrorFields(isPrismaError(arg) ? arg : arg.cause), ...(digest !== undefined ? { digest } : {}) };
  });
}

/** console.error(context, ids, safe error fields). Use it instead of logging an error object whole. */
export function logError(context: string, error: unknown, ids: LogIds = {}): void {
  console.error(context, { ...ids, ...safeErrorFields(error) });
}
