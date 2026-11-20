import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const ENGINE_ROOT = resolve(import.meta.dirname, "../../..");
const FOUNDRY_ENTRIES = [
  "src/worker/unit/foundry-implement.ts",
  "src/worker/unit/foundry-evaluation.ts",
  "src/worker/unit/foundry-examine.ts",
];
const FORBIDDEN_DIRECTORIES = [
  "src/custody/",
  "src/gateway/",
  "src/apps/",
  "src/repository/",
  "src/agent/capabilities/",
];
const ADMITTED_MODULES = ["src/repository/contract.ts"];
const FORBIDDEN_MODULES = [
  "src/kernel/hpke.ts",
  "src/kernel/handover.ts",
  "src/kernel/key-derivation.ts",
  "src/agent/agent-port.ts",
  "src/worker/unit/native-method.ts",
  "src/worker/unit/model-runtime.ts",
  "src/worker/unit/method-clients.ts",
  "src/worker/unit/execution-run.ts",
  "src/worker/unit/tree-pool.ts",
  "src/worker/unit/worker-ports.ts",
  "src/worker/unit/chain-host.ts",
  "src/worker/unit/chain-runner.ts",
  "src/worker/unit/tasks-credential.ts",
  "src/worker/unit/tasks-open-world.ts",
  "src/worker/unit/tasks-output.ts",
  "src/worker/unit/tasks-run.ts",
  "src/worker/unit/tasks-seed.ts",
  "src/worker/unit/tasks-steps.ts",
  "src/worker/unit/tasks-trees.ts",
  "src/worker/unit/tasks-turns.ts",
  "src/worker/unit/tasks-turns-file.ts",
  "src/worker/unit/tasks-verify.ts",
];
const FORBIDDEN_NAMES = [
  "RepositoryTransport",
  "MethodClients",
  "ExecutionRun",
  "hostToolsOf",
  "hkdf",
  "hkdfSync",
  "createCipheriv",
  "createDecipheriv",
  "createPrivateKey",
];
const FORBIDDEN_PACKAGES = ["@hpke/core"];

interface Imports {
  resolved: string[];
  unresolved: string[];
}

function specifiersOf(file: string): string[] {
  return ts
    .preProcessFile(readFileSync(file, "utf8"), true, true)
    .importedFiles.map(({ fileName }) => fileName);
}

function importsOf(file: string): Imports {
  const targets = specifiersOf(file)
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => resolve(dirname(file), specifier));
  return {
    resolved: targets.filter((target) => existsSync(target)),
    unresolved: targets.filter((target) => !existsSync(target)),
  };
}

interface FoundryClosure {
  modules: string[];
  unresolved: string[];
}

function foundryClosure(): FoundryClosure {
  const reached = new Set(
    FOUNDRY_ENTRIES.map((entry) => resolve(ENGINE_ROOT, entry)),
  );
  const unresolved: string[] = [];
  const queue = [...reached];
  for (let file = queue.shift(); file; file = queue.shift()) {
    const imports = importsOf(file);
    unresolved.push(...imports.unresolved);
    for (const target of imports.resolved)
      if (!reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
  }
  const relativeOf = (file: string) => relative(ENGINE_ROOT, file);
  return {
    modules: [...reached].map(relativeOf).sort(),
    unresolved: unresolved.map(relativeOf),
  };
}

function forbidden(file: string): boolean {
  if (ADMITTED_MODULES.includes(file)) return false;
  return (
    FORBIDDEN_MODULES.includes(file) ||
    FORBIDDEN_DIRECTORIES.some((directory) => file.startsWith(directory))
  );
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
  const { modules, unresolved } = foundryClosure();
  assert.deepEqual(unresolved, []);
  assert.deepEqual(modules.filter(forbidden), []);
  assert.deepEqual(
    modules.flatMap((file) =>
      importedNames(file)
        .filter((name) => FORBIDDEN_NAMES.includes(name))
        .map((name) => `${file}: ${name}`),
    ),
    [],
  );
  assert.deepEqual(
    modules.flatMap((file) =>
      specifiersOf(resolve(ENGINE_ROOT, file))
        .filter((specifier) => FORBIDDEN_PACKAGES.includes(specifier))
        .map((specifier) => `${file}: ${specifier}`),
    ),
    [],
  );
});
