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

describe("typographyIssues and class names", () => {
  it("leaves Tailwind class lists alone (« my-1.5 h-12 », « z-30 h-8 », « h-9 min-w-14 », « ${block} h-7 »)", () => {
    for (const classes of ["my-1.5 h-12", "my-0.5 h-6", "sticky top-0 z-30 h-8 border-b", "flex h-6 min-w-6 items-center", "inline-flex h-9 min-w-14"]) {
      expect(typographyIssues(classes)).toEqual([]);
      expect(frenchSpacing(classes)).toBe(classes);
    }
    expect(typographyIssues(" h-7 w-72", { continuation: true })).toEqual([]);
    expect(typographyIssues(" h de route", { continuation: true }).map((i) => i.kind)).toEqual(["unit"]);
  });
});

/**
 * The screens keep French typography: every text written in the source (strings, template
 * parts, JSX text) of the interface and the server messages. Tests are left out (some match
 * text normalized by Testing Library). A text that must keep an ordinary space (a code, a
 * pattern) goes in a skipped position (className, href, key…) or gets an exception here.
 * Class names are never text: a no-break space there glues two classes into one that matches
 * no CSS rule (the planning tracks lost their height that way), so a second test forbids it.
 */
describe("French typography of the source", () => {
  const root = path.resolve(__dirname, "..");
  const SKIPPED_ATTRIBUTES = new Set(["className", "href", "id", "htmlFor", "name", "value", "type", "key"]);
  /** Functions whose arguments are class names. */
  const CLASS_HELPERS = new Set(["cn", "clsx", "buttonClasses"]);
  /** A Tailwind utility with a value (« h-12 », « min-w-14 », « z-30 », « top-[3px] », « md:h-6 »). */
  const UTILITY = /^(?:[a-z-]+:)*-?[a-z]+(?:-[a-z]+)*-(?:\d|\[|full|auto|screen|px|none)/;
  const NO_BREAK = /[\u00a0\u202f]/;

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(file);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && entry.name !== "typography.ts" ? [file] : [];
    });
  }

  /** The literal is a class name: under a className attribute, or an argument of cn()/clsx()… */
  function inClassContext(node: ts.Node): boolean {
    for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
      if (ts.isJsxAttribute(current)) return current.name.getText() === "className";
      if (ts.isCallExpression(current) && CLASS_HELPERS.has(current.expression.getText())) return true;
      if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) return false;
    }
    return false;
  }

  function skipped(node: ts.Node): boolean {
    if (inClassContext(node)) return true;
    const parent = node.parent;
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isLiteralTypeNode(parent)) return true;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
    if (ts.isJsxAttribute(parent) && SKIPPED_ATTRIBUTES.has(parent.name.getText())) return true;
    if (ts.isNewExpression(parent) && parent.expression.getText() === "RegExp") return true;
    if (ts.isCallExpression(parent) && /^(console\.\w+|logError|logWarn|logInfo)$/.test(parent.expression.getText())) return true;
    return false;
  }

  function parse(file: string): ts.SourceFile {
    const source = fs.readFileSync(file, "utf8");
    return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  }

  it("has no no-break space in a class name", () => {
    const found: string[] = [];
    for (const file of sourceFiles(root)) {
      const sf = parse(file);
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
          const words = node.text.split(/(?=[\u00a0\u202f])/);
          const glued = words.slice(1).some((word) => UTILITY.test(word.slice(1)));
          if (glued || (NO_BREAK.test(node.text) && inClassContext(node))) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            found.push(`${path.relative(root, file)}:${line + 1} ${JSON.stringify(node.text.slice(0, 60))}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(found).toEqual([]);
  });

  it("has no ordinary space before « : ; ! ? », inside « » or between a number and its unit", () => {
    const found: string[] = [];
    for (const file of sourceFiles(root)) {
      const sf = parse(file);
      const check = (text: string, node: ts.Node, continuation: boolean) => {
        for (const issue of typographyIssues(text, { continuation })) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          found.push(`${path.relative(root, file)}:${line + 1} (${issue.kind}) ${JSON.stringify(issue.excerpt)}`);
        }
      };
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) && !skipped(node)) check(node.getText(sf).slice(1, -1), node, true);
        else if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
          if (!ts.isTaggedTemplateExpression(node.parent) && !ts.isTaggedTemplateExpression(node.parent.parent) && !inClassContext(node)) {
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
