/**
 * Every server action that writes to the database must write its audit event
 * (lib/audit.ts) too, and so must every route handler (a route.ts file under app/, e.g.
 * the driver's status route). Static check of the source: for each function
 * exported by a "use server" file, and each HTTP method exported by a route
 * handler, the function and the same-file helpers it calls either contain no
 * write (`db.x.create(`, `tx.x.updateMany(`…), or call `audit(`. A write
 * delegated to another module (runOptimization, syncOpenTrips…) is that
 * module's to trace and is not seen here.
 *
 * The check is per action, not per branch: an action that traces one of its
 * writes passes. An action that writes without a trace on purpose goes in
 * AUDIT_EXEMPT with the reason; the list is checked to stay accurate.
 *
 * The scan reads function declarations, so a "use server" file must export
 * its actions as `export async function` only (no `export const`, `export
 * default` or `export { … }`, which it could not see); top-level `const x =
 * async (…) =>` helpers are read too.
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

const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function isRouteHandlerFile(file: string): boolean {
  const relative = path.relative(SRC, file).split(path.sep);
  return relative[0] === "app" && /^route\.tsx?$/.test(relative.at(-1) ?? "");
}

/** Exports the scan cannot read as functions: values, default and re-exports (`export type` is erased). */
const UNREADABLE_EXPORT = /^export\s+(?:const|let|var|default|\{|\*)/m;

/** A top-level function held by a variable: `const name = async (` or `= function`. */
const ARROW_HELPER = /^(?:const|let) (\w+)(?::[^=]+)? = (?:async )?(?:function\b|\(|\w+ =>)/;

/**
 * Top-level functions: from `function name` at column 0 to the next `}` at
 * column 0, and from `const name = async (` to the next line starting with `}`
 * (or the same line for a one-line arrow).
 */
function topLevelFunctions(source: string): TopLevelFunction[] {
  const lines = source.split("\n");
  const functions: TopLevelFunction[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const declared = /^(export )?(?:async )?function (\w+)/.exec(line);
    if (declared?.[2]) {
      let end = i;
      while (end < lines.length && lines[end] !== "}") end++;
      functions.push({ name: declared[2], exported: Boolean(declared[1]), body: lines.slice(i, end + 1).join("\n") });
      continue;
    }
    const arrow = ARROW_HELPER.exec(line);
    if (!arrow?.[1]) continue;
    let end = i;
    if (!line.trimEnd().endsWith(";")) {
      end = i + 1;
      while (end < lines.length && !/^[})]/.test(lines[end] ?? "")) end++;
    }
    functions.push({ name: arrow[1], exported: false, body: lines.slice(i, end + 1).join("\n") });
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

/** Exported server actions, and the HTTP methods of route handlers. */
function serverActions(): ActionReport[] {
  return sourceFiles(SRC).flatMap((file) => {
    const source = fs.readFileSync(file, "utf8");
    const routeHandler = isRouteHandlerFile(file);
    if (!isServerActionFile(source) && !routeHandler) return [];
    const functions = topLevelFunctions(source);
    const relative = path.relative(SRC, file).split(path.sep).join("/");
    return functions
      .filter((fn) => fn.exported && (!routeHandler || HTTP_METHODS.has(fn.name)))
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

  it("finds the server actions and the route handlers (the scan is not vacuous)", () => {
    expect(new Set(actions.map((a) => a.key.split("#")[0])).size).toBeGreaterThanOrEqual(15);
    expect(actions.filter((a) => a.writes).length).toBeGreaterThanOrEqual(40);
    expect(actions.map((a) => a.key)).toContain("app/(regulator)/parametres/actions.ts#saveSettings");
    // The driver's status route writes the stop and the trip: it is scanned like an action.
    expect(actions.find((a) => a.key === "app/api/chauffeur/stops/[id]/status/route.ts#POST")).toMatchObject({ writes: true, audits: true });
    expect(actions.map((a) => a.key)).toContain("app/api/chauffeur/session/route.ts#POST");
  });

  it("every \"use server\" file exports its actions as function declarations the scan can read", () => {
    const unreadable = sourceFiles(SRC)
      .filter((file) => {
        const source = fs.readFileSync(file, "utf8");
        return isServerActionFile(source) && UNREADABLE_EXPORT.test(source);
      })
      .map((file) => path.relative(SRC, file));
    expect(unreadable).toEqual([]);
  });

  it("every action and route handler that writes also writes its audit event", () => {
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

  it("follows a write delegated to a top-level arrow helper", () => {
    const source = [
      '"use server";',
      "const NOT_FOUND = \"Introuvable.\";",
      "const save = async (tx: Tx, id: string) => {",
      "  await tx.vehicle.update({ where: { id } });",
      "};",
      "const drop = (id: string) => db.vehicle.delete({ where: { id } });",
      "export async function untraced() {",
      "  await db.$transaction((tx) => save(tx, id));",
      "  await drop(id);",
      "}",
    ].join("\n");
    const functions = topLevelFunctions(source);
    expect(functions.map((f) => f.name)).toEqual(["save", "drop", "untraced"]);
    const reached = closure(functions[2]!, functions);
    expect(reached.map((f) => f.name).sort()).toEqual(["drop", "save", "untraced"]);
    expect(reached.some((f) => WRITE.test(f.body)) && !reached.some((f) => AUDIT_CALL.test(f.body))).toBe(true);
  });

  it("refuses exports it cannot read", () => {
    for (const line of [
      "export const save = async () => {};",
      "export default async function save() {}",
      "export { save };",
      "export * from './other';",
    ]) {
      expect(UNREADABLE_EXPORT.test(`"use server";\n${line}`), line).toBe(true);
    }
    expect(UNREADABLE_EXPORT.test('"use server";\nexport type State = { ok: boolean };\nexport async function save() {}')).toBe(false);
  });
});
