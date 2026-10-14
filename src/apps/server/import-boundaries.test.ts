import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { ESLint } from "eslint";

const ENGINE_ROOT = resolve(import.meta.dirname, "../../..");
const BOUNDARY_RULE = "boundaries/dependencies";
const IMPORT_RULE = "@typescript-eslint/no-restricted-imports";
const PROPERTY_RULE = "no-restricted-properties";
const REFUSED_PROBES = ["src/intake/probe.ts", "src/kernel/probe.ts"];
const ADMITTED_PROBE = "src/apps/server/probe.ts";
const STORAGE_PROBE = "src/storage/probe.ts";
const SERVICE_IMPORT_SOURCE = `import { IntakeService } from "../intake/service.ts";\nexport const probe = IntakeService;\n`;
const EXPECTED_REFUSALS = 1;
const NO_REFUSALS = 0;

function probeSource(filePath: string): string {
  const specifier = filePath.startsWith("src/kernel/")
    ? "./service-mint.ts"
    : filePath.startsWith("src/apps/server/")
      ? "../../kernel/service-mint.ts"
      : "../kernel/service-mint.ts";
  return `import { mintServiceIdentity } from "${specifier}";\nexport const probe = mintServiceIdentity("intake");\n`;
}

async function ruleErrors(
  ruleId: string,
  filePath: string,
  source: string,
): Promise<number> {
  const eslint = new ESLint({ cwd: ENGINE_ROOT });
  const [result] = await eslint.lintText(source, {
    filePath: resolve(ENGINE_ROOT, filePath),
  });
  assert.ok(result);
  return result.messages.filter((message) => message.ruleId === ruleId).length;
}

function boundaryErrors(
  filePath: string,
  source = probeSource(filePath),
): Promise<number> {
  return ruleErrors(BOUNDARY_RULE, filePath, source);
}

test("an import of service-mint.ts outside src/apps/server/ is a boundary error", async () => {
  for (const filePath of REFUSED_PROBES)
    assert.equal(await boundaryErrors(filePath), EXPECTED_REFUSALS, filePath);
});

test("an import of service-mint.ts from src/apps/server/ is admitted", async () => {
  assert.equal(await boundaryErrors(ADMITTED_PROBE), NO_REFUSALS);
});

test("an import of a service file from src/storage/ is a boundary error", async () => {
  assert.equal(
    await boundaryErrors(STORAGE_PROBE, SERVICE_IMPORT_SOURCE),
    EXPECTED_REFUSALS,
  );
});

const WORKER_ELEMENT_DIRECTORIES = ["src/worker/unit", "src/apps/worker"];
const REFUSED_PROPERTIES = ["env", "exit", "on", "kill", "abort", "dlopen"];
const THREAD_ENTRY = "src/apps/worker/thread.ts";
const WORKER_INDEX = "src/apps/worker/index.ts";
const UNIT_FILE = "src/worker/unit/probe.ts";

function importSource(directory: string, target: string, names: string) {
  const depth = directory.split("/").length;
  const specifier = `${"../".repeat(depth - 1)}${target}`;
  return `import ${names} from "${specifier}";\nexport const probe = 0;\n`;
}

test("an import of a service, the invocation chain or the configuration from a worker element is a boundary error", async () => {
  for (const directory of WORKER_ELEMENT_DIRECTORIES)
    for (const target of [
      "worker/service.ts",
      "project/service.ts",
      "gateway/invocation.ts",
      "gateway/auth/jwt.ts",
      "config/index.ts",
    ])
      assert.equal(
        await boundaryErrors(
          `${directory}/probe.ts`,
          importSource(directory, target, "* as probe"),
        ),
        EXPECTED_REFUSALS,
        `${directory} ${target}`,
      );
});

test("an import of a contract from a worker element is admitted", async () => {
  for (const directory of WORKER_ELEMENT_DIRECTORIES)
    assert.equal(
      await boundaryErrors(
        `${directory}/probe.ts`,
        importSource(directory, "scheduler/contract.ts", "type * as probe"),
      ),
      NO_REFUSALS,
      directory,
    );
});

test("an import of node:sqlite or a value of the store from a worker element is a lint error", async () => {
  for (const directory of WORKER_ELEMENT_DIRECTORIES) {
    const file = `${directory}/probe.ts`;
    assert.equal(
      await ruleErrors(
        IMPORT_RULE,
        file,
        'import { DatabaseSync } from "node:sqlite";\nexport const probe = DatabaseSync;\n',
      ),
      EXPECTED_REFUSALS,
      directory,
    );
    assert.equal(
      await ruleErrors(
        IMPORT_RULE,
        file,
        importSource(directory, "kernel/store.ts", "{ Store }"),
      ),
      EXPECTED_REFUSALS,
      directory,
    );
    assert.equal(
      await ruleErrors(
        IMPORT_RULE,
        file,
        importSource(directory, "kernel/store.ts", "type { Store }"),
      ),
      NO_REFUSALS,
      directory,
    );
  }
});

test("a worker thread import is a lint error outside the thread entry", async () => {
  const source =
    'import { Worker } from "node:worker_threads";\nexport const probe = Worker;\n';
  for (const file of [UNIT_FILE, "src/apps/worker/probe.ts", WORKER_INDEX])
    assert.equal(
      await ruleErrors(IMPORT_RULE, file, source),
      EXPECTED_REFUSALS,
      file,
    );
  assert.equal(
    await ruleErrors(IMPORT_RULE, THREAD_ENTRY, source),
    NO_REFUSALS,
  );
  assert.equal(
    await ruleErrors(
      IMPORT_RULE,
      "src/apps/worker/probe.ts",
      'import type { MessagePort } from "node:worker_threads";\nexport type Probe = MessagePort;\n',
    ),
    NO_REFUSALS,
  );
});

test("a refused property of process is a lint error in a worker element except the entries", async () => {
  for (const property of REFUSED_PROPERTIES) {
    const source = `export const probe = process.${property};\n`;
    for (const file of [UNIT_FILE, "src/apps/worker/probe.ts"])
      assert.equal(
        await ruleErrors(PROPERTY_RULE, file, source),
        EXPECTED_REFUSALS,
        `${file} ${property}`,
      );
    for (const file of [WORKER_INDEX, THREAD_ENTRY])
      assert.equal(
        await ruleErrors(PROPERTY_RULE, file, source),
        NO_REFUSALS,
        `${file} ${property}`,
      );
  }
});
