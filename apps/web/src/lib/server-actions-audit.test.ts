/**
 * Every server action that writes to the database must write its audit event
 * (lib/audit.ts) too. Static check of the source: for each function exported
 * by a "use server" file, the function and the same-file helpers it calls
 * either contain no write (`db.x.create(`, `tx.x.updateMany(`…), or call
 * `audit(`. A write delegated to another module (runOptimization,
 * syncOpenTrips…) is that module's to trace and is not seen here.
 *
 * The check is per action, not per branch: an action that traces one of its
 * writes passes. An action that writes without a trace on purpose goes in
 * AUDIT_EXEMPT with the reason; the list is checked to stay accurate.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");

/** "<file relative to src>#<function>" -> why it writes without an audit event. */
const AUDIT_EXEMPT: Record<string, string> = {};

const WRITE_METHODS = "create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany";
const WRITE = new RegExp(`\\b(?:db|tx|client|prisma)\\.\\w+\\.(?:${WRITE_METHODS})\\(|\\$executeRaw`);
const AUDIT_CALL = /\baudit\(/;

type TopLevelFunction = { name: string; exported: boolean; body: string };

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [full] : [];
  });
}

function isServerActionFile(source: string): boolean {
  return /^\s*["']use server["'];/.test(source);
}

/** Top-level function declarations: from `function name` at column 0 to the next `}` at column 0. */
function topLevelFunctions(source: string): TopLevelFunction[] {
  const lines = source.split("\n");
  const functions: TopLevelFunction[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(export )?(?:async )?function (\w+)/.exec(lines[i] ?? "");
    if (!match?.[2]) continue;
    let end = i;
    while (end < lines.length && lines[end] !== "}") end++;
    functions.push({ name: match[2], exported: Boolean(match[1]), body: lines.slice(i, end + 1).join("\n") });
  }
  return functions;
}

/** The function and every same-file function it calls, transitively. */
function closure(start: TopLevelFunction, all: readonly TopLevelFunction[]): TopLevelFunction[] {
  const seen = new Set([start.name]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const other of all) {
      if (!seen.has(other.name) && new RegExp(`\\b${other.name}\\(`).test(current.body)) {
        seen.add(other.name);
        queue.push(other);
      }
    }
  }
  return all.filter((fn) => seen.has(fn.name));
}

type ActionReport = { key: string; writes: boolean; audits: boolean };

function serverActions(): ActionReport[] {
  return sourceFiles(SRC).flatMap((file) => {
    const source = fs.readFileSync(file, "utf8");
    if (!isServerActionFile(source)) return [];
    const functions = topLevelFunctions(source);
    const relative = path.relative(SRC, file).split(path.sep).join("/");
    return functions
      .filter((fn) => fn.exported)
      .map((fn) => {
        const reached = closure(fn, functions);
        return {
          key: `${relative}#${fn.name}`,
          writes: reached.some((f) => WRITE.test(f.body)),
          audits: reached.some((f) => AUDIT_CALL.test(f.body)),
        };
      });
  });
}

describe("server actions and the audit trail", () => {
  const actions = serverActions();

  it("finds the server actions (the scan is not vacuous)", () => {
    expect(new Set(actions.map((a) => a.key.split("#")[0])).size).toBeGreaterThanOrEqual(15);
    expect(actions.filter((a) => a.writes).length).toBeGreaterThanOrEqual(40);
    expect(actions.map((a) => a.key)).toContain("app/(regulator)/parametres/actions.ts#saveSettings");
  });

  it("every action that writes also writes its audit event", () => {
    const missing = actions.filter((a) => a.writes && !a.audits && !(a.key in AUDIT_EXEMPT)).map((a) => a.key);
    expect(missing).toEqual([]);
  });

  it("keeps the exemption list accurate", () => {
    const byKey = new Map(actions.map((a) => [a.key, a]));
    for (const key of Object.keys(AUDIT_EXEMPT)) {
      const action = byKey.get(key);
      expect(action, `${key} is exempted but no longer exists`).toBeDefined();
      expect(action?.writes && !action.audits, `${key} is exempted but no longer needs it`).toBe(true);
    }
  });
});

describe("topLevelFunctions (the scanner itself)", () => {
  it("cuts a file into its top-level functions and sees writes and audit calls", () => {
    const source = [
      '"use server";',
      "async function helper(tx: Tx) {",
      "  await tx.trip.updateMany({ where: {} });",
      "}",
      "export async function traced() {",
      "  await db.$transaction(async (tx) => {",
      "    await helper(tx);",
      "    await audit(tx, user, entry);",
      "  });",
      "}",
      "export async function untraced() {",
      "  await db.vehicle.update({ where: { id } });",
      "}",
    ].join("\n");
    const functions = topLevelFunctions(source);
    expect(functions.map((f) => [f.name, f.exported])).toEqual([
      ["helper", false],
      ["traced", true],
      ["untraced", true],
    ]);
    const traced = closure(functions[1]!, functions);
    expect(traced.some((f) => WRITE.test(f.body)) && traced.some((f) => AUDIT_CALL.test(f.body))).toBe(true);
    expect(WRITE.test(functions[2]!.body) && !AUDIT_CALL.test(functions[2]!.body)).toBe(true);
  });
});
