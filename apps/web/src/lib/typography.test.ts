import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { frenchSpacing, NBSP, NNBSP, typographyIssues } from "./typography";

describe("frenchSpacing", () => {
  it("puts no-break spaces before « : », between a number and its unit, narrow ones before « ; ! ? » and inside « »", () => {
    expect(frenchSpacing("Pas de place : Taxi 1 (Gap) ; « Taxi 2 » en pause 45 min, 12 km, 30 € ?")).toBe(
      `Pas de place${NBSP}: Taxi 1 (Gap)${NNBSP}; «${NNBSP}Taxi 2${NNBSP}» en pause 45${NBSP}min, 12${NBSP}km, 30${NBSP}€${NNBSP}?`,
    );
  });

  it("leaves times, words starting like a unit and text already right alone", () => {
    expect(frenchSpacing("RDV 09:30 à 3 minutes, 2 heures, 4 sur 5, 3 s'est")).toBe("RDV 09:30 à 3 minutes, 2 heures, 4 sur 5, 3 s'est");
    const right = `Retard${NBSP}: 5${NBSP}min`;
    expect(frenchSpacing(right)).toBe(right);
    expect(typographyIssues(right)).toEqual([]);
  });

  it("counts a leading « ; » or « : » of a text that continues another one", () => {
    expect(typographyIssues(" ; 3 contraintes", { continuation: true }).map((i) => i.kind)).toEqual(["mark"]);
    expect(typographyIssues(" ; 3 contraintes")).toEqual([]);
  });
});

/**
 * The screens keep French typography: every text written in the source (strings, template
 * parts, JSX text) of the interface and the server messages. Tests are left out (some match
 * text normalized by Testing Library). A text that must keep an ordinary space (a code, a
 * pattern) goes in a skipped position (className, href, key…) or gets an exception here.
 */
describe("French typography of the source", () => {
  const root = path.resolve(__dirname, "..");
  const SKIPPED_ATTRIBUTES = new Set(["className", "href", "id", "htmlFor", "name", "value", "type", "key"]);

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(file);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && entry.name !== "typography.ts" ? [file] : [];
    });
  }

  function skipped(node: ts.Node): boolean {
    const parent = node.parent;
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isLiteralTypeNode(parent)) return true;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
    if (ts.isJsxAttribute(parent) && SKIPPED_ATTRIBUTES.has(parent.name.getText())) return true;
    if (ts.isNewExpression(parent) && parent.expression.getText() === "RegExp") return true;
    if (ts.isCallExpression(parent) && /^(console\.\w+|logError|logWarn|logInfo)$/.test(parent.expression.getText())) return true;
    return false;
  }

  it("has no ordinary space before « : ; ! ? », inside « » or between a number and its unit", () => {
    const found: string[] = [];
    for (const file of sourceFiles(root)) {
      const source = fs.readFileSync(file, "utf8");
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const check = (text: string, node: ts.Node, continuation: boolean) => {
        for (const issue of typographyIssues(text, { continuation })) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          found.push(`${path.relative(root, file)}:${line + 1} (${issue.kind}) ${JSON.stringify(issue.excerpt)}`);
        }
      };
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) && !skipped(node)) check(node.getText(sf).slice(1, -1), node, true);
        else if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
          if (!ts.isTaggedTemplateExpression(node.parent) && !ts.isTaggedTemplateExpression(node.parent.parent)) {
            const text = node.getText(sf);
            check(text.slice(1, ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ? -2 : -1), node, true);
          }
        } else if (ts.isJsxText(node)) {
          const siblings = node.parent && "children" in node.parent ? [...(node.parent as ts.JsxElement).children] : [];
          const index = siblings.indexOf(node);
          check(node.getText(sf), node, index > 0 && ts.isJsxExpression(siblings[index - 1] as ts.Node));
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(found).toEqual([]);
  });
});
