import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  affectedReport,
  buildGraph,
  closureOf,
  computeChanges,
  floorOf,
  GLOBAL_INPUTS,
  INERT_INPUTS,
  runTests,
  selectTests,
} from "./affected-tests.mjs";
import { affectedReportSchema } from "../src/worker/unit/affected.ts";
import { stopAfter } from "../src/kernel/stop-test-support.ts";

const MODIFIED = "modified";
const ADDED = "added";
const DELETED = "deleted";
const RENAMED = "renamed";
const REASON_MAX_BYTES = 256;
const LONG_NAME_LENGTH = 400;
const EMPTY_MODULE = "export {};\n";
const TEST_BODY = 'import test from "node:test";\n';
const SSHD_MODULE = "src/repository/sshd-test-support.ts";
const SSHD_TEST =
  'import { startTestSshd } from "../sshd-test-support.ts";\nstartTestSshd();\n';
const SSHD_TEST_PATH = "src/repository/sub/ssh.test.ts";
const ENTRY_POINT = fileURLToPath(
  new URL("./affected-tests.mjs", import.meta.url),
);
const AFFECTED_REPORTER = fileURLToPath(
  new URL("./affected-reporter.mjs", import.meta.url),
);
const TEST_REPORTER = fileURLToPath(
  new URL("./test-reporter.mjs", import.meta.url),
);
const RUN_TIMEOUT_MS = 120000;
const DROPPED_VARIABLES = ["KANTHORD_CHANGES", "KANTHORD_AFFECTED_REPORT"];
const SUCCESS = 0;
const FAILED = 1;
const RUN_ERROR = 2;
const FIXTURE_PACKAGE = {
  type: "module",
  scripts: {
    "test:files":
      "node --test --test-reporter=./scripts/test-reporter.mjs --test-timeout=60000",
  },
};
const PASSING_TEST =
  'import test from "node:test";\ntest("passes", () => {});\n';
const FAILING_TEST =
  'import test from "node:test";\ntest("fails", () => { throw new Error("boom"); });\n';
const FLAKY_TEST = `import test from "node:test";
import { existsSync, writeFileSync } from "node:fs";
test("fails once", () => {
  if (existsSync("marker")) return;
  writeFileSync("marker", "");
  throw new Error("first run");
});
`;
const FLAKY_MARKER = "marker";
const RERUN_FILE_LIMIT = 8;

function flakyTest(marker) {
  return FLAKY_TEST.replaceAll(FLAKY_MARKER, marker);
}

const NESTED_TEST = `import { describe, it } from "node:test";
describe("outer", () => {
  describe("inner", () => {
    it("leaf", () => { throw new Error("boom"); });
  });
});
`;
const WAITING_TEST =
  'import test from "node:test";\ntest("waits", async () => { await new Promise((done) => setTimeout(done, 200)); });\n';
const FLOOR_FILES = {
  "src/a.ts": EMPTY_MODULE,
  "src/b.ts": EMPTY_MODULE,
  "src/main.ts": 'import "./a.ts";\nimport "./b.ts";\n',
  "src/full.test.ts": `import "./main.ts";\n${WAITING_TEST}`,
  "src/part.test.ts": `import "./a.ts";\n${WAITING_TEST}`,
};
const UNLOADABLE_TEST = 'import "./missing.mjs";\n';

async function repository(t, files) {
  const root = await mkdtemp(join(tmpdir(), "kanthord-affected-"));
  stopAfter(t, () => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function select(root, changes) {
  const { graph, ...selected } = selectTests(root, changes);
  assert.ok(graph.present instanceof Set);
  return selected;
}

function withoutFloor({ floor, ...report }) {
  assert.ok(Number.isInteger(floor.tests));
  return report;
}

function change(path, status = MODIFIED, previous_path) {
  return previous_path === undefined
    ? { path, status }
    : { path, status, previous_path };
}

function related(tests, excluded_e2e = []) {
  return { selection: "related", reason: null, tests, excluded_e2e };
}

const NONE = { selection: "none", reason: null, tests: [], excluded_e2e: [] };

test("an import edge selects the test of the importer", async (t) => {
  const root = await repository(t, {
    "src/a.ts": EMPTY_MODULE,
    "src/b.ts": 'import { x } from "./a.ts";\nexport const y = x;\n',
    "src/b.test.ts": 'import "./b.ts";\n',
    "src/other.test.ts": TEST_BODY,
  });
  assert.deepEqual(
    select(root, [change("src/a.ts")]),
    related(["src/b.test.ts"]),
  );
});

test("a bare and a node specifier make no edge", async (t) => {
  const root = await repository(t, {
    "src/a.ts": EMPTY_MODULE,
    "src/a.test.ts": 'import test from "node:test";\nimport "yaml";\n',
  });
  assert.deepEqual(select(root, [change("src/a.ts")]), NONE);
});

test("a re-export makes an edge", async (t) => {
  const root = await repository(t, {
    "src/a.ts": EMPTY_MODULE,
    "src/index.ts": 'export * from "./a.ts";\nexport { z } from "./a.ts";\n',
    "src/index.test.ts": 'import "./index.ts";\n',
  });
  assert.deepEqual(
    select(root, [change("src/a.ts")]),
    related(["src/index.test.ts"]),
  );
});

test("an import type makes an edge", async (t) => {
  const root = await repository(t, {
    "src/a.ts": "export type A = string;\n",
    "src/b.test.ts": 'let value: import("./a.ts").A = "";\nvalue;\n',
  });
  assert.deepEqual(
    select(root, [change("src/a.ts")]),
    related(["src/b.test.ts"]),
  );
});

test("a dynamic import with a string literal makes an edge", async (t) => {
  const root = await repository(t, {
    "src/a.ts": EMPTY_MODULE,
    "src/b.test.ts": 'await import("./a.ts");\n',
  });
  assert.deepEqual(
    select(root, [change("src/a.ts")]),
    related(["src/b.test.ts"]),
  );
});

test("a URL with a string literal makes a file edge", async (t) => {
  const root = await repository(t, {
    "static/data.json": "{}",
    "src/b.test.ts": 'new URL("../static/data.json", import.meta.url);\n',
  });
  assert.deepEqual(
    select(root, [change("static/data.json")]),
    related(["src/b.test.ts"]),
  );
});

test("a URL that ends with a slash makes a prefix edge", async (t) => {
  const root = await repository(t, {
    "static/dir/one.json": "{}",
    "static/other.json": "{}",
    "src/b.test.ts": 'new URL("../static/dir/", import.meta.url);\n',
  });
  assert.deepEqual(
    select(root, [change("static/dir/one.json")]),
    related(["src/b.test.ts"]),
  );
  assert.deepEqual(select(root, [change("static/other.json")]), NONE);
});

test("a template URL makes a prefix edge to the text before the substitution", async (t) => {
  const root = await repository(t, {
    "static/dir/part-one.json": "{}",
    "static/dir/other.json": "{}",
    "src/b.test.ts":
      "const n = 'x';\nnew URL(`../static/dir/part-${n}.json`, import.meta.url);\n",
  });
  assert.deepEqual(
    select(root, [change("static/dir/part-one.json")]),
    related(["src/b.test.ts"]),
  );
  assert.deepEqual(select(root, [change("static/dir/other.json")]), NONE);
});

test("a prefix edge to the repository root is dropped", async (t) => {
  const root = await repository(t, {
    "src/lone.ts": EMPTY_MODULE,
    "static/data.json": "{}",
    "src/b.test.ts":
      'new URL("../", import.meta.url);\nnew URL("../../", import.meta.url);\nnew URL("./", import.meta.url);\n',
  });
  assert.deepEqual(select(root, [change("static/data.json")]), NONE);
});

test("the data table makes static/openapi/ an input of static/openapi.yaml", async (t) => {
  const root = await repository(t, {
    "static/openapi.yaml": "openapi: 3.1.0\n",
    "static/openapi/part.yaml": "a: 1\n",
    "src/spec.test.ts": 'new URL("../static/openapi.yaml", import.meta.url);\n',
  });
  assert.deepEqual(
    select(root, [change("static/openapi/part.yaml")]),
    related(["src/spec.test.ts"]),
  );
});

test("a deleted module selects each importer that still names it", async (t) => {
  const root = await repository(t, {
    "src/b.test.ts": 'import "./gone.ts";\n',
  });
  assert.deepEqual(
    select(root, [change("src/gone.ts", DELETED)]),
    related(["src/b.test.ts"]),
  );
});

test("a rename selects the importers of the previous path", async (t) => {
  const root = await repository(t, {
    "src/new.ts": EMPTY_MODULE,
    "src/b.test.ts": 'import "./old.ts";\n',
  });
  assert.deepEqual(
    select(root, [change("src/new.ts", RENAMED, "src/old.ts")]),
    related(["src/b.test.ts"]),
  );
});

test("an untracked file is a graph node", async (t) => {
  const root = await repository(t, {
    "src/new.ts": EMPTY_MODULE,
    "src/new.test.ts": 'import "./new.ts";\n',
  });
  assert.deepEqual(
    select(root, [change("src/new.ts", ADDED)]),
    related(["src/new.test.ts"]),
  );
});

for (const input of GLOBAL_INPUTS) {
  test(`the global input ${input} selects each test that needs no sshd`, async (t) => {
    const root = await repository(t, {
      [SSHD_MODULE]: EMPTY_MODULE,
      [SSHD_TEST_PATH]: SSHD_TEST,
      "src/a.test.ts": TEST_BODY,
      "src/apps/server/e2e-one.test.ts": TEST_BODY,
      "scripts/test-path.test.mjs": TEST_BODY,
    });
    const expected = {
      selection: "all",
      reason: `global input: ${input}`,
      tests: [
        "scripts/test-path.test.mjs",
        "src/a.test.ts",
        "src/apps/server/e2e-one.test.ts",
      ],
      excluded_e2e: [SSHD_TEST_PATH],
    };
    assert.deepEqual(select(root, [change(input)]), expected);
    assert.deepEqual(
      select(root, [change("src/a.test.ts", RENAMED, input)]),
      expected,
    );
  });
}

test("an inert path that no edge names is ignored", async (t) => {
  const root = await repository(t, { "src/a.test.ts": TEST_BODY });
  const paths = [
    "docs/guide/page.md",
    ".agents/plan/one.md",
    ".github/workflows/other.yml",
    ".husky/pre-commit",
    ".opencode/config.json",
    "README.md",
    "LICENSE",
    ".gitignore",
    ".prettierignore",
    ".prettierrc.json",
    "eslint.config.js",
    ".envrc",
    ".worktreeinclude",
  ];
  assert.deepEqual(INERT_INPUTS, [
    "docs/**",
    ".agents/**",
    ".github/**",
    ".husky/**",
    ".opencode/**",
    "*.md",
    ...paths.filter((path) => !path.includes("/") && !path.endsWith(".md")),
  ]);
  assert.deepEqual(
    select(
      root,
      paths.map((path) => change(path)),
    ),
    NONE,
  );
});

test("a nested markdown file is not inert", async (t) => {
  const root = await repository(t, { "src/a.test.ts": TEST_BODY });
  const result = select(root, [change("src/notes.md", ADDED)]);
  assert.equal(result.selection, "all");
  assert.equal(result.reason, "unknown path: src/notes.md");
});

test("an inert path that an edge names selects the importer", async (t) => {
  const root = await repository(t, {
    "docs/spec.md": "text\n",
    "src/b.test.ts": 'new URL("../docs/spec.md", import.meta.url);\n',
  });
  assert.deepEqual(
    select(root, [change("docs/spec.md")]),
    related(["src/b.test.ts"]),
  );
});

test("an unknown path selects each test that needs no sshd", async (t) => {
  const root = await repository(t, {
    [SSHD_MODULE]: EMPTY_MODULE,
    [SSHD_TEST_PATH]: SSHD_TEST,
    "src/a.test.ts": TEST_BODY,
    "src/apps/server/e2e-one.test.ts": TEST_BODY,
  });
  assert.deepEqual(select(root, [change("Makefile", ADDED)]), {
    selection: "all",
    reason: "unknown path: Makefile",
    tests: ["src/a.test.ts", "src/apps/server/e2e-one.test.ts"],
    excluded_e2e: [SSHD_TEST_PATH],
  });
});

test("the reason holds at most 256 UTF-8 bytes", async (t) => {
  const root = await repository(t, { "src/a.test.ts": TEST_BODY });
  const path = `é${"é".repeat(LONG_NAME_LENGTH)}`;
  const { reason } = select(root, [change(path, ADDED)]);
  assert.ok(Buffer.byteLength(reason) <= REASON_MAX_BYTES);
  assert.ok(reason.startsWith("unknown path: é"));
  assert.ok(!reason.includes("\uFFFD"));
});

test("a reached e2e path is selected", async (t) => {
  const root = await repository(t, {
    "src/a.ts": EMPTY_MODULE,
    "src/apps/server/e2e-one.test.ts": 'import "../../a.ts";\n',
    "src/apps/server/e2e-two.test.ts": TEST_BODY,
    "src/a.test.ts": 'import "./a.ts";\n',
  });
  assert.deepEqual(
    select(root, [change("src/a.ts")]),
    related(["src/a.test.ts", "src/apps/server/e2e-one.test.ts"]),
  );
});

test("a test that imports startTestSshd is excluded", async (t) => {
  const root = await repository(t, {
    [SSHD_MODULE]: "export function startTestSshd() {}\n",
    "src/repository/ssh.test.ts":
      'import { startTestSshd } from "./sshd-test-support.ts";\nstartTestSshd();\n',
    "src/repository/alias.test.ts":
      'import { startTestSshd as start } from "./sshd-test-support.ts";\nstart();\n',
    "src/repository/plain.test.ts": 'import "./sshd-test-support.ts";\n',
    "src/apps/server/e2e-sshd.test.ts":
      'import { startTestSshd } from "../../repository/sshd-test-support.ts";\nstartTestSshd();\n',
  });
  assert.deepEqual(
    select(root, [change(SSHD_MODULE)]),
    related(
      ["src/repository/plain.test.ts"],
      [
        "src/apps/server/e2e-sshd.test.ts",
        "src/repository/alias.test.ts",
        "src/repository/ssh.test.ts",
      ],
    ),
  );
});

test("a namespace import of sshd-test-support.ts is excluded", async (t) => {
  const root = await repository(t, {
    [SSHD_MODULE]: "export function startTestSshd() {}\n",
    "src/repository/plain.test.ts": 'import "./sshd-test-support.ts";\n',
    "src/repository/namespace.test.ts":
      'import * as sshd from "./sshd-test-support.ts";\nsshd.startTestSshd();\n',
  });
  assert.deepEqual(
    select(root, [change(SSHD_MODULE)]),
    related(
      ["src/repository/plain.test.ts"],
      ["src/repository/namespace.test.ts"],
    ),
  );
});

test("a dynamic import of sshd-test-support.ts is excluded", async (t) => {
  const root = await repository(t, {
    [SSHD_MODULE]: "export function startTestSshd() {}\n",
    "src/repository/plain.test.ts": 'import "./sshd-test-support.ts";\n',
    "src/repository/dynamic.test.ts":
      'const sshd = await import("./sshd-test-support.ts");\nsshd.startTestSshd();\n',
  });
  assert.deepEqual(
    select(root, [change(SSHD_MODULE)]),
    related(
      ["src/repository/plain.test.ts"],
      ["src/repository/dynamic.test.ts"],
    ),
  );
});

test("an unrelated namespace import is still run", async (t) => {
  const root = await repository(t, {
    "src/a.ts": "export function start() {}\n",
    "src/a.test.ts": 'import * as a from "./a.ts";\na.start();\n',
  });
  assert.deepEqual(
    select(root, [change("src/a.ts")]),
    related(["src/a.test.ts"]),
  );
});

test("a test that names startTestSshd only in a comment is excluded", async (t) => {
  const root = await repository(t, {
    "src/a.ts": EMPTY_MODULE,
    "src/a.test.ts": 'import "./a.ts";\n',
    "src/b.test.ts": 'import "./a.ts";\n// startTestSshd\n',
  });
  assert.deepEqual(
    select(root, [change("src/a.ts")]),
    related(["src/a.test.ts"], ["src/b.test.ts"]),
  );
});

test("a changed unit test selects itself", async (t) => {
  const root = await repository(t, {
    "src/a.test.ts": TEST_BODY,
    "scripts/affected-tests.test.mjs": TEST_BODY,
  });
  assert.deepEqual(
    select(root, [change("src/a.test.ts")]),
    related(["src/a.test.ts"]),
  );
  assert.deepEqual(
    select(root, [change("scripts/affected-tests.test.mjs")]),
    related(["scripts/affected-tests.test.mjs"]),
  );
});

test("a change that reaches no unit test gives none", async (t) => {
  const root = await repository(t, {
    "src/a.ts": EMPTY_MODULE,
    "src/a.test.ts": TEST_BODY,
  });
  assert.deepEqual(select(root, [change("src/a.ts")]), NONE);
});

test("the change set of engine #285 selects the tracking test", async (t) => {
  const root = await repository(t, {
    "src/tracking/contract.ts": "export const KIND = 1;\n",
    "src/tracking/service.ts":
      'import { KIND } from "./contract.ts";\nexport const kind = KIND;\n',
    "src/tracking/service.test.ts":
      'import { kind } from "./service.ts";\nimport type { Kind } from "./contract.ts";\nkind;\n',
    "src/worker/service.ts": EMPTY_MODULE,
    "src/worker/service.test.ts": 'import "./service.ts";\n',
  });
  assert.deepEqual(
    select(root, [change("src/tracking/contract.ts")]),
    related(["src/tracking/service.test.ts"]),
  );
});

test("the change set of engine #287 selects the changed worker test", async (t) => {
  const root = await repository(t, {
    "src/tracking/contract.ts": "export const KIND = 1;\n",
    "src/tracking/service.test.ts": 'import "./contract.ts";\n',
    "src/worker/service.ts": EMPTY_MODULE,
    "src/worker/service.test.ts": 'import "./service.ts";\n',
  });
  assert.deepEqual(
    select(root, [change("src/worker/service.test.ts")]),
    related(["src/worker/service.test.ts"]),
  );
});

async function fixture(t, files, packageJson = FIXTURE_PACKAGE) {
  const root = await repository(t, {
    "package.json": JSON.stringify(packageJson),
    ...files,
  });
  await mkdir(join(root, "scripts"));
  await copyFile(TEST_REPORTER, join(root, "scripts/test-reporter.mjs"));
  await copyFile(
    AFFECTED_REPORTER,
    join(root, "scripts/affected-reporter.mjs"),
  );
  return root;
}

function commitAll(root) {
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
}

function runNode(root, args, extra = {}) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const name of DROPPED_VARIABLES) delete env[name];
  Object.assign(env, extra);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
  });
  assert.equal(result.signal, null);
  return result;
}

function runEntry(root, args = [], extra = {}) {
  const result = runNode(root, [ENTRY_POINT, ...args], extra);
  const lines = result.stdout.trimEnd().split("\n");
  const report = JSON.parse(lines.at(-1));
  affectedReportSchema.parse(report);
  return { ...result, report };
}

async function changesFile(root, files) {
  const path = join(root, "changes.json");
  const changes = {
    version: 1,
    binding_id: "binding",
    repository: "repository",
    base_commit: "base",
    head_commit: "head",
    files,
  };
  await writeFile(path, JSON.stringify(changes));
  return path;
}

test("the reporter names a nested test and a file that fails to load", async (t) => {
  const root = await fixture(t, {
    "src/nested.test.ts": NESTED_TEST,
    "src/unloadable.test.ts": UNLOADABLE_TEST,
  });
  const result = runNode(root, [
    "--test",
    `--test-reporter=${AFFECTED_REPORTER}`,
    "src/nested.test.ts",
    "src/unloadable.test.ts",
  ]);
  const lines = result.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
  const ids = lines.filter((line) => "name" in line);
  const timed = lines
    .filter((line) => "seconds" in line)
    .map(({ file }) => file)
    .sort();
  assert.deepEqual(timed, ["src/nested.test.ts", "src/unloadable.test.ts"]);
  assert.deepEqual(
    ids.map(({ file, name }) => `${file}|${name}`).sort(),
    [
      "src/nested.test.ts|outer",
      "src/nested.test.ts|outer > inner",
      "src/nested.test.ts|outer > inner > leaf",
      "src/unloadable.test.ts|src/unloadable.test.ts",
    ].sort(),
  );
});

test("a failed test gives the report, the report file and the exit code 1", async (t) => {
  const root = await fixture(t, {
    "src/a.ts": EMPTY_MODULE,
    "src/a.test.ts": `import "./a.ts";\n${FAILING_TEST}`,
    "src/b.test.ts": PASSING_TEST,
  });
  const reportPath = join(root, "report.json");
  const result = runEntry(root, [], {
    KANTHORD_CHANGES: await changesFile(root, [change("src/a.ts")]),
    KANTHORD_AFFECTED_REPORT: reportPath,
  });
  assert.equal(result.status, FAILED);
  assert.deepEqual(withoutFloor(result.report), {
    version: 2,
    selection: "related",
    reason: null,
    tests: ["src/a.test.ts"],
    failed: [{ file: "src/a.test.ts", name: "fails" }],
    flaky: [],
    excluded_e2e: [],
  });
  assert.deepEqual(
    JSON.parse(await readFile(reportPath, "utf8")),
    result.report,
  );
});

test("a test that fails once and passes on the rerun is flaky", async (t) => {
  const root = await fixture(t, {
    "src/a.ts": EMPTY_MODULE,
    "src/a.test.ts": `import "./a.ts";\n${FLAKY_TEST}`,
  });
  const result = runEntry(root, [], {
    KANTHORD_CHANGES: await changesFile(root, [change("src/a.ts")]),
  });
  assert.equal(result.status, SUCCESS);
  assert.deepEqual(result.report.failed, []);
  assert.deepEqual(result.report.flaky, [
    { file: "src/a.test.ts", name: "fails once" },
  ]);
});

async function flakyFilesFixture(t, count) {
  const numbers = Array.from({ length: count }, (_, index) => index + 1);
  const files = { "src/a.ts": EMPTY_MODULE };
  for (const number of numbers) {
    files[`src/t${number}.test.ts`] =
      `import "./a.ts";\n${flakyTest(`marker${number}`)}`;
  }
  const root = await fixture(t, files);
  const result = runEntry(root, [], {
    KANTHORD_CHANGES: await changesFile(root, [change("src/a.ts")]),
  });
  const ids = numbers.map((number) => ({
    file: `src/t${number}.test.ts`,
    name: "fails once",
  }));
  return { result, ids };
}

test("more than 8 files with failed ids run no rerun", async (t) => {
  const { result, ids } = await flakyFilesFixture(t, RERUN_FILE_LIMIT + 1);
  assert.equal(result.status, FAILED);
  assert.deepEqual(result.report.failed, ids);
  assert.deepEqual(result.report.flaky, []);
});

test("8 files with failed ids run the reruns", async (t) => {
  const { result, ids } = await flakyFilesFixture(t, RERUN_FILE_LIMIT);
  assert.equal(result.status, SUCCESS);
  assert.deepEqual(result.report.failed, []);
  assert.deepEqual(result.report.flaky, ids);
});

test("a file that fails to load is a failed id with the file path as name", async (t) => {
  const root = await fixture(t, {
    "src/unloadable.test.ts": UNLOADABLE_TEST,
  });
  const result = runEntry(root, [], {
    KANTHORD_CHANGES: await changesFile(root, [
      change("src/unloadable.test.ts"),
    ]),
  });
  assert.equal(result.status, FAILED);
  assert.deepEqual(result.report.failed, [
    { file: "src/unloadable.test.ts", name: "src/unloadable.test.ts" },
  ]);
});

test("the input of --base is the change set against the merge base", async (t) => {
  const root = await fixture(t, {
    "src/a.ts": EMPTY_MODULE,
    "src/a.test.ts": `import "./a.ts";\n${PASSING_TEST}`,
    "src/b.test.ts": PASSING_TEST,
  });
  commitAll(root);
  await writeFile(join(root, "src/a.ts"), "export const changed = 1;\n");
  await writeFile(join(root, "src/c.test.ts"), PASSING_TEST);
  const result = runEntry(root, ["--base", "HEAD"]);
  assert.equal(result.status, SUCCESS);
  assert.equal(result.report.selection, "related");
  assert.deepEqual(result.report.tests, ["src/a.test.ts", "src/c.test.ts"]);
  assert.deepEqual(result.report.failed, []);
  assert.deepEqual(result.report.flaky, []);
});

test("the change set of the working tree holds each status", async (t) => {
  const root = await fixture(t, {
    "src/modified.ts": EMPTY_MODULE,
    "src/deleted.ts": EMPTY_MODULE,
    "src/old.ts": "export const unchanged = 1;\n",
  });
  commitAll(root);
  await writeFile(join(root, "src/modified.ts"), "export const x = 1;\n");
  await rm(join(root, "src/deleted.ts"));
  await rename(join(root, "src/old.ts"), join(root, "src/new.ts"));
  await writeFile(join(root, "src/untracked.ts"), EMPTY_MODULE);
  execFileSync("git", ["add", "src/new.ts", "src/old.ts"], { cwd: root });
  assert.deepEqual(computeChanges(root, "HEAD"), [
    change("src/deleted.ts", DELETED),
    change("src/modified.ts", MODIFIED),
    change("src/new.ts", RENAMED, "src/old.ts"),
    change("src/untracked.ts", ADDED),
  ]);
});

test("a failed reached e2e test gives the exit code 1", async (t) => {
  const root = await fixture(t, {
    "src/a.ts": EMPTY_MODULE,
    "src/apps/server/e2e-one.test.ts": `import "../../a.ts";\n${FAILING_TEST}`,
  });
  const result = runEntry(root, [], {
    KANTHORD_CHANGES: await changesFile(root, [change("src/a.ts")]),
  });
  assert.equal(result.status, FAILED);
  assert.deepEqual(result.report.tests, ["src/apps/server/e2e-one.test.ts"]);
  assert.deepEqual(result.report.failed, [
    { file: "src/apps/server/e2e-one.test.ts", name: "fails" },
  ]);
});

test("the none selection gives empty lists and the exit code 0", async (t) => {
  const root = await fixture(t, { "src/a.test.ts": FAILING_TEST });
  const reportPath = join(root, "report.json");
  const result = runEntry(root, [], {
    KANTHORD_CHANGES: await changesFile(root, [change("docs/readme.txt")]),
    KANTHORD_AFFECTED_REPORT: reportPath,
  });
  assert.equal(result.status, SUCCESS);
  assert.deepEqual(withoutFloor(result.report), {
    version: 2,
    selection: "none",
    reason: null,
    tests: [],
    failed: [],
    flaky: [],
    excluded_e2e: [],
  });
  assert.deepEqual(
    JSON.parse(await readFile(reportPath, "utf8")),
    result.report,
  );
});

test("a global input gives the all selection with a reason", async (t) => {
  const root = await fixture(t, { "src/a.test.ts": PASSING_TEST });
  const reportPath = join(root, "report.json");
  const result = runEntry(root, [], {
    KANTHORD_CHANGES: await changesFile(root, [change("package.json")]),
    KANTHORD_AFFECTED_REPORT: reportPath,
  });
  assert.equal(result.status, SUCCESS);
  assert.deepEqual(withoutFloor(result.report), {
    version: 2,
    selection: "all",
    reason: "global input: package.json",
    tests: ["src/a.test.ts"],
    failed: [],
    flaky: [],
    excluded_e2e: [],
  });
});

test("a first run that fails with no failed id is a run error", async (t) => {
  const root = await fixture(
    t,
    {
      "src/a.ts": EMPTY_MODULE,
      "src/a.test.ts": `import "./a.ts";\n${PASSING_TEST}`,
    },
    { type: "module", scripts: { "test:files": 'node -e "process.exit(1)"' } },
  );
  const reportPath = join(root, "report.json");
  const result = runNode(root, [ENTRY_POINT], {
    KANTHORD_CHANGES: await changesFile(root, [change("src/a.ts")]),
    KANTHORD_AFFECTED_REPORT: reportPath,
  });
  assert.equal(result.status, RUN_ERROR);
  assert.equal(existsSync(reportPath), false);
  assert.match(result.stderr, /without a failed test/);
});

function outsideTestContext(run) {
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    return run();
  } finally {
    if (context === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = context;
  }
}

test("the floor holds each test file whose closure holds every production file", async (t) => {
  const root = await repository(t, FLOOR_FILES);
  assert.deepEqual(floorOf(buildGraph(root)), ["src/full.test.ts"]);
});

test("a data edge counts in the closure", async (t) => {
  const root = await repository(t, {
    "src/main.ts": 'new URL("../static/openapi/", import.meta.url);\n',
    "src/full.test.ts": 'import "./main.ts";\n',
    "static/openapi/one.yaml": "a: 1\n",
    "static/openapi/two.yaml": "b: 2\n",
  });
  const closure = closureOf(buildGraph(root), "src/full.test.ts");
  assert.ok(closure.includes("static/openapi/one.yaml"));
  assert.ok(closure.includes("static/openapi/two.yaml"));
});

test("a template head that is not a directory counts in the closure", async (t) => {
  const root = await repository(t, {
    "src/main.ts": "const x = 'y';\nnew URL(`./w${x}`, import.meta.url);\n",
    "src/w.ts": EMPTY_MODULE,
  });
  assert.ok(closureOf(buildGraph(root), "src/main.ts").includes("src/w.ts"));
});

test("a selection all writes version 2 with the floor and the total test time", async (t) => {
  const root = await fixture(t, FLOOR_FILES);
  const report = outsideTestContext(() =>
    affectedReport(root, [change("package.json")]),
  );
  assert.equal(report.version, 2);
  assert.equal(report.floor.tests, 1);
  assert.ok(report.floor.seconds > 0);
  assert.ok(report.floor.total_seconds >= report.floor.seconds);
});

test("a related selection writes a floor with a null total", async (t) => {
  const root = await fixture(t, FLOOR_FILES);
  const report = outsideTestContext(() =>
    affectedReport(root, [change("src/a.ts")]),
  );
  assert.equal(report.floor.tests, 1);
  assert.equal(report.floor.total_seconds, null);
});

test("a file that a test leaves untracked does not change the floor", async (t) => {
  const leftover = `import "./main.ts";\nimport { writeFileSync } from "node:fs";\nimport test from "node:test";\ntest("leaves a test file", () => {\n  writeFileSync("src/left.test.ts", 'import "./main.ts";\\n');\n});\n`;
  const root = await fixture(t, {
    ...FLOOR_FILES,
    "src/leave.test.ts": leftover,
  });
  commitAll(root);
  const report = outsideTestContext(() =>
    affectedReport(root, [change("src/a.ts")]),
  );
  assert.ok(existsSync(join(root, "src/left.test.ts")));
  assert.deepEqual(report.tests, [
    "src/full.test.ts",
    "src/leave.test.ts",
    "src/part.test.ts",
  ]);
  assert.equal(report.floor.tests, 2);
});

test("a selection none writes a floor of 0 seconds", async (t) => {
  const root = await fixture(t, FLOOR_FILES);
  const report = outsideTestContext(() =>
    affectedReport(root, [change("docs/readme.txt")]),
  );
  assert.equal(report.selection, "none");
  assert.equal(report.floor.tests, 1);
  assert.equal(report.floor.seconds, 0);
  assert.equal(report.floor.total_seconds, null);
});

test("the reporter writes the test time of each file", async (t) => {
  const root = await fixture(t, FLOOR_FILES);
  const run = outsideTestContext(() =>
    runTests(root, ["src/full.test.ts", "src/part.test.ts"], 2),
  );
  assert.ok(run.seconds.get("src/full.test.ts") > 0);
  assert.ok(run.seconds.get("src/part.test.ts") > 0);
});
