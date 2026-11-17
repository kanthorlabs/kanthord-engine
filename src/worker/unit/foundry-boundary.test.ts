import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const ENGINE_ROOT = resolve(import.meta.dirname, "../../..");
const FOUNDRY_ENTRIES = [
  "src/worker/unit/foundry-implement.ts",
  "src/worker/unit/foundry-evaluation.ts",
  "src/worker/unit/foundry-examine.ts",
];
const CONTRACT_FILE = "contract.ts";
const FORBIDDEN_MODULES = [
  "src/repository/connector.ts",
  "src/repository/index.ts",
  "src/gateway/client.ts",
  "src/gateway/direct-client.ts",
  "src/gateway/client-result.ts",
  "src/worker/unit/method-clients.ts",
  "src/worker/unit/execution-run.ts",
  "src/custody/execution-store.ts",
  "src/custody/client.ts",
  "src/custody/contract.ts",
  "src/worker/unit/tree-pool.ts",
  "src/apps/worker/execution.ts",
  "src/worker/unit/worker-ports.ts",
  "src/worker/unit/chain-host.ts",
  "src/worker/unit/chain-runner.ts",
];
const FORBIDDEN_NAMES = [
  "RepositoryTransport",
  "MethodClients",
  "ExecutionRun",
  "hostToolsOf",
];

function importsOf(file: string): string[] {
  return ts
    .preProcessFile(readFileSync(file, "utf8"), true, true)
    .importedFiles.map(({ fileName }) => fileName)
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => resolve(dirname(file), specifier))
    .filter((target) => existsSync(target));
}

function foundryModules(): string[] {
  const reached = new Set(
    FOUNDRY_ENTRIES.map((entry) => resolve(ENGINE_ROOT, entry)),
  );
  const queue = [...reached];
  for (let file = queue.shift(); file; file = queue.shift()) {
    if (basename(file) === CONTRACT_FILE) continue;
    for (const target of importsOf(file))
      if (!reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
  }
  return [...reached].map((file) => relative(ENGINE_ROOT, file)).sort();
}

function importedNames(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(ENGINE_ROOT, file), "utf8"),
    ts.ScriptTarget.Latest,
  );
  return source.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings;
      return bindings && ts.isNamedImports(bindings)
        ? bindings.elements.map((element) =>
            (element.propertyName ?? element.name).getText(source),
          )
        : [];
    }
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      return clause && ts.isNamedExports(clause)
        ? clause.elements.map((element) =>
            (element.propertyName ?? element.name).getText(source),
          )
        : [];
    }
    return [];
  });
}

test("no module of the Foundry imports a transport, a client, the execution run, the credential store, the custody contract, the tree pool or the host tools", () => {
  const modules = foundryModules();
  assert.deepEqual(
    modules.filter((file) => FORBIDDEN_MODULES.includes(file)),
    [],
  );
  assert.deepEqual(
    modules.flatMap((file) =>
      importedNames(file)
        .filter((name) => FORBIDDEN_NAMES.includes(name))
        .map((name) => `${file}: ${name}`),
    ),
    [],
  );
});
