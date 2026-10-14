import assert from "node:assert/strict";
import { dirname, relative, resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { ESLint } from "eslint";

const ENGINE_ROOT = resolve(import.meta.dirname, "../../..");
const BOUNDARY_RULE = "boundaries/dependencies";
const IMPORT_RULE = "@typescript-eslint/no-restricted-imports";
const PROPERTY_RULE = "no-restricted-properties";
const GLOBAL_RULE = "no-restricted-globals";
const SYNTAX_RULE = "no-restricted-syntax";
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
const REFUSED_PROPERTIES = [
  "env",
  "exit",
  "exitCode",
  "on",
  "once",
  "addListener",
  "kill",
  "abort",
  "dlopen",
];
const THREAD_ENTRY = "src/apps/worker/thread.ts";
const WORKER_INDEX = "src/apps/worker/index.ts";
const UNIT_FILE = "src/worker/unit/probe.ts";
const WORKER_FILE = "src/apps/worker/probe.ts";
const UNIT_TEST_FILE = "src/worker/unit/probe.test.ts";
const WORKER_TEST_FILE = "src/apps/worker/probe.test.ts";
const REFUSED_GLOBAL_SOURCES = [
  "export const probe = process.env;\n",
  "export const probe = globalThis.process.env;\n",
  "const proc = process;\nexport const probe = proc.env;\n",
  'export const probe = process["env"];\n',
  'process.once("SIGTERM", () => {});\n',
  'process.addListener("SIGTERM", () => {});\n',
  "process.exitCode = 1;\n",
];
const REFUSED_MODULE_SOURCES = [
  'import { env } from "node:process";\nexport const probe = env;\n',
  'import proc from "node:process";\nexport const probe = proc.env;\n',
  'import proc from "process";\nexport const probe = proc.env;\n',
  'import { Worker } from "worker_threads";\nexport const probe = Worker;\n',
  'import { createRequire } from "node:module";\nexport const probe = createRequire;\n',
  'import { createRequire } from "module";\nexport const probe = createRequire;\n',
];
const DYNAMIC_IMPORT_SOURCE =
  'export const probe = await import("node:sqlite");\n';

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
      "gateway/port.ts",
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

test("a global of process, globalThis or an alias is a lint error in a worker element except the entries and the test files", async () => {
  for (const source of REFUSED_GLOBAL_SOURCES) {
    for (const file of [UNIT_FILE, WORKER_FILE])
      assert.equal(
        await ruleErrors(GLOBAL_RULE, file, source),
        EXPECTED_REFUSALS,
        `${file} ${source}`,
      );
    for (const file of [
      WORKER_INDEX,
      THREAD_ENTRY,
      UNIT_TEST_FILE,
      WORKER_TEST_FILE,
    ])
      assert.equal(
        await ruleErrors(GLOBAL_RULE, file, source),
        NO_REFUSALS,
        `${file} ${source}`,
      );
  }
});

test("an import of process, module or a worker thread under any specifier is a lint error in a worker element", async () => {
  for (const source of REFUSED_MODULE_SOURCES)
    for (const file of [UNIT_FILE, WORKER_FILE, WORKER_INDEX, UNIT_TEST_FILE])
      assert.equal(
        await ruleErrors(IMPORT_RULE, file, source),
        EXPECTED_REFUSALS,
        `${file} ${source}`,
      );
  for (const source of REFUSED_MODULE_SOURCES.filter(
    (entry) => !entry.includes("worker_threads"),
  ))
    assert.equal(
      await ruleErrors(IMPORT_RULE, THREAD_ENTRY, source),
      EXPECTED_REFUSALS,
      source,
    );
});

test("a dynamic import is a lint error in a worker element", async () => {
  for (const file of [UNIT_FILE, WORKER_FILE, WORKER_INDEX, THREAD_ENTRY])
    assert.equal(
      await ruleErrors(SYNTAX_RULE, file, DYNAMIC_IMPORT_SOURCE),
      EXPECTED_REFUSALS,
      file,
    );
});

test("an import of a test support file from a worker element is a lint error outside the test files", async () => {
  for (const directory of WORKER_ELEMENT_DIRECTORIES)
    for (const target of [
      "kernel/test-support.ts",
      "agent/test-support.ts",
      "worker/test-support.ts",
      "worker/unit/test-support.ts",
    ]) {
      const source = importSource(directory, target, "* as probe");
      assert.equal(
        await ruleErrors(IMPORT_RULE, `${directory}/probe.ts`, source),
        EXPECTED_REFUSALS,
        `${directory} ${target}`,
      );
      assert.equal(
        await ruleErrors(IMPORT_RULE, `${directory}/probe.test.ts`, source),
        NO_REFUSALS,
        `${directory} ${target}`,
      );
    }
  assert.equal(
    await ruleErrors(
      IMPORT_RULE,
      THREAD_ENTRY,
      importSource("src/apps/worker", "kernel/test-support.ts", "* as probe"),
    ),
    EXPECTED_REFUSALS,
  );
});

test("an import of a worker unit file other than its entry is a boundary error from the worker wrapper", async () => {
  const directory = "src/apps/worker";
  for (const target of ["verification.ts", "workspace.ts", "native-method.ts"])
    assert.equal(
      await boundaryErrors(
        `${directory}/probe.ts`,
        importSource(directory, `worker/unit/${target}`, "* as probe"),
      ),
      EXPECTED_REFUSALS,
      target,
    );
  assert.equal(
    await boundaryErrors(
      `${directory}/probe.ts`,
      importSource(directory, "worker/unit/index.ts", "* as probe"),
    ),
    NO_REFUSALS,
  );
  assert.equal(
    await boundaryErrors(
      `${directory}/probe.test.ts`,
      importSource(directory, "worker/unit/test-support.ts", "* as probe"),
    ),
    NO_REFUSALS,
  );
});

test("a name of the repository other than RepositoryComponent is a lint error in a worker element", async () => {
  for (const directory of WORKER_ELEMENT_DIRECTORIES) {
    const file = `${directory}/probe.ts`;
    assert.equal(
      await ruleErrors(
        IMPORT_RULE,
        file,
        importSource(directory, "repository/index.ts", "{ GitHubPlatform }"),
      ),
      EXPECTED_REFUSALS,
      directory,
    );
    assert.equal(
      await ruleErrors(
        IMPORT_RULE,
        file,
        importSource(directory, "repository/index.ts", "* as probe"),
      ),
      EXPECTED_REFUSALS,
      directory,
    );
    assert.equal(
      await ruleErrors(
        IMPORT_RULE,
        file,
        importSource(
          directory,
          "repository/index.ts",
          "{ RepositoryComponent }",
        ),
      ),
      NO_REFUSALS,
      directory,
    );
  }
});

const SERVICE_FILE = /^src\/(?!kernel\/)[^/]+\/service\.ts$/;
const REFUSED_CLOSURE_FILES = [
  "src/kernel/store.ts",
  "src/gateway/invocation.ts",
  "src/gateway/port.ts",
];
const REFUSED_CLOSURE_DIRECTORIES = ["src/config/", "src/gateway/auth/"];
const CONTRACT_FILE = /^src\/[^/]+\/contract\.ts$/;
const REFUSED_CLOSURE_MODULES = ["node:sqlite", "node:module"];
const UNIT_DIRECTORY_PREFIX = "src/worker/unit/";
const WORKER_DIRECTORY_PREFIX = "src/apps/worker/";
const SOURCE_PREFIX = "src/";
const FIRST_SOURCE_LINE = 1;

function relativeSpecifier(from: string, to: string): string {
  const specifier = relative(dirname(from), to);
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

async function refusedTargets(
  importer: string,
  targets: string[],
): Promise<string[]> {
  const source = `${targets
    .map((target) => `import "${relativeSpecifier(importer, target)}";`)
    .join("\n")}\n`;
  const eslint = new ESLint({ cwd: ENGINE_ROOT });
  const [result] = await eslint.lintText(source, {
    filePath: resolve(ENGINE_ROOT, importer),
  });
  assert.ok(result);
  return result.messages
    .filter(
      (message) =>
        message.ruleId === BOUNDARY_RULE || message.ruleId === IMPORT_RULE,
    )
    .map((message) => targets[message.line - FIRST_SOURCE_LINE]!);
}

test("the module closure of the worker thread holds only the targets that the worker elements allow and no database or module loader", async () => {
  const { metafile } = await build({
    entryPoints: [resolve(ENGINE_ROOT, THREAD_ENTRY)],
    absWorkingDir: ENGINE_ROOT,
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  const inputs = Object.entries(metafile.inputs).filter(([file]) =>
    file.startsWith(SOURCE_PREFIX),
  );
  const files = inputs.map(([file]) => file);
  assert.ok(files.includes(THREAD_ENTRY));
  assert.ok(files.includes("src/apps/worker/unit.ts"));
  const directTargets = (prefix: string) => [
    ...new Set(
      inputs
        .filter(([file]) => file.startsWith(prefix))
        .flatMap(([, input]) => input.imports.map((entry) => entry.path))
        .filter((path) => path.startsWith(SOURCE_PREFIX)),
    ),
  ];
  const unitTargets = directTargets(UNIT_DIRECTORY_PREFIX);
  const workerTargets = directTargets(WORKER_DIRECTORY_PREFIX);
  assert.deepEqual(await refusedTargets(UNIT_FILE, unitTargets), []);
  assert.deepEqual(await refusedTargets(WORKER_FILE, workerTargets), []);
  const allowedDirectories = [
    ...new Set(
      [...unitTargets, ...workerTargets, UNIT_FILE, WORKER_FILE].map(dirname),
    ),
  ];
  assert.deepEqual(
    files.filter(
      (file) =>
        !(
          CONTRACT_FILE.test(file) ||
          allowedDirectories.some((directory) =>
            file.startsWith(`${directory}/`),
          )
        ) ||
        SERVICE_FILE.test(file) ||
        REFUSED_CLOSURE_FILES.includes(file) ||
        REFUSED_CLOSURE_DIRECTORIES.some((directory) =>
          file.startsWith(directory),
        ),
    ),
    [],
  );
  const modules = Object.values(metafile.inputs).flatMap((input) =>
    input.imports.map((entry) => entry.path),
  );
  assert.deepEqual(
    modules.filter((path) => REFUSED_CLOSURE_MODULES.includes(path)),
    [],
  );
});

const SLOT_TOKEN_RULE = "no-restricted-imports";
const SLOT_TOKEN_SOURCE = `import { generateSlotJWT } from "SPECIFIER";\nexport const probe = generateSlotJWT;\n`;

test("an import of generateSlotJWT is a lint error outside src/apps/server/", async () => {
  for (const [filePath, specifier] of [
    ["src/apps/cli/probe.ts", "../../gateway/auth/jwt.ts"],
    ["src/gateway/probe.ts", "./auth/jwt.ts"],
    ["src/worker/probe.ts", "../gateway/auth/jwt.ts"],
    ["src/kernel/probe.ts", "../gateway/auth/jwt.ts"],
  ] as const)
    assert.equal(
      await ruleErrors(
        SLOT_TOKEN_RULE,
        filePath,
        SLOT_TOKEN_SOURCE.replace("SPECIFIER", specifier),
      ),
      EXPECTED_REFUSALS,
      filePath,
    );
});

test("an import of generateSlotJWT from src/apps/server/ is admitted", async () => {
  assert.equal(
    await ruleErrors(
      SLOT_TOKEN_RULE,
      ADMITTED_PROBE,
      SLOT_TOKEN_SOURCE.replace("SPECIFIER", "../../gateway/auth/jwt.ts"),
    ),
    NO_REFUSALS,
  );
});
