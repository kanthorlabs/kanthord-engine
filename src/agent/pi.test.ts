import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import { loadPi, piAgentDirectory, PI_OFFLINE_VALUE } from "./pi.ts";

test("only the pi loader imports the runtime as a value", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const packageName = "@earendil-works/pi-coding-agent";
  const paths: string[] = [];
  for (const path of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (!path.endsWith(".ts")) continue;
    const source = ts.createSourceFile(
      path,
      readFileSync(join(root, path), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === packageName &&
        !node.importClause?.isTypeOnly
      )
        paths.push(path);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.some(
          (argument) =>
            ts.isStringLiteral(argument) && argument.text === packageName,
        )
      )
        paths.push(path);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(paths, ["agent/pi.ts"]);
  assert.ok(paths.includes("agent/pi.ts"));
});

test("pi loader caches the import and fixes the environment before import", async () => {
  const first = loadPi();
  assert.equal(process.env.PI_OFFLINE, PI_OFFLINE_VALUE);
  assert.equal(process.env.PI_CODING_AGENT_DIR, piAgentDirectory());
  assert.equal(first, loadPi());
  assert.equal(await first, await loadPi());
});
