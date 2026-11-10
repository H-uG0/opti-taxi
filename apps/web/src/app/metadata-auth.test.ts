import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Next.js resolves a page's metadata alongside its layout: the layout's requireUser redirects,
 * but the <title> is already in the response. A generateMetadata that reads the database (a
 * person's or a facility's name as the tab title) checks the role itself, first.
 */
describe("generateMetadata of the protected pages", () => {
  function pages(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return pages(file);
      return entry.name === "page.tsx" ? [file] : [];
    });
  }

  it("calls requireUser before reading the database", () => {
    const root = path.resolve(__dirname);
    const unguarded: string[] = [];
    let checked = 0;
    for (const file of pages(root)) {
      const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      for (const statement of sf.statements) {
        if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== "generateMetadata" || !statement.body) continue;
        if (!/\bdb\./.test(statement.body.getText(sf))) continue;
        checked += 1;
        const first = statement.body.statements[0];
        if (!first || !/^await requireUser\(/.test(first.getText(sf))) unguarded.push(path.relative(root, file));
      }
    }
    expect(unguarded).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(5);
  });
});
