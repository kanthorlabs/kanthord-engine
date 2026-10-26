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
  GLOBAL_INPUTS,
  INERT_INPUTS,
  computeChanges,
  selectTests,
} from "./affected-tests.mjs";
import { affectedReportSchema } from "../src/worker/unit/affected.ts";

const MODIFIED = "modified";
const ADDED = "added";
const DELETED = "deleted";
const RENAMED = "renamed";
const REASON_MAX_BYTES = 256;
const LONG_NAME_LENGTH = 400;
const EMPTY_MODULE = "export {};\n";
const TEST_BODY = 'import test from "node:test";\n';
const SSHD_MODULE = "src/repository/test-sshd.ts";
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
const NESTED_TEST = `import { describe, it } from "node:test";
describe("outer", () => {
  describe("inner", () => {
    it("leaf", () => { throw new Error("boom"); });
  });
});
`;
const UNLOADABLE_TEST = 'import "./missing.mjs";\n';

async function repository(t, files) {
  const root = await mkdtemp(join(tmpdir(), "kanthord-affected-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function change(path, status = MODIFIED, previous_path) {
  return previous_path === undefined
    ? { path, status }
    : { path, status, previous_path };
}

function selected(tests, excluded_e2e = []) {
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
    selectTests(root, [change("src/a.ts")]),
    selected(["src/b.test.ts"]),
  );
});

test("a bare and a node specifier make no edge", async (t) => {
  const root = await repository(t, {
    "src/a.ts": EMPTY_MODULE,
    "src/a.test.ts": 'import test from "node:test";\nimport "yaml";\n',
  });
  assert.deepEqual(selectTests(root, [change("src/a.ts")]), NONE);
});

test("a re-export makes an edge", async (t) => {
  const root = await repository(t, {
    "src/a.ts": EMPTY_MODULE,
    "src/index.ts": 'export * from "./a.ts";\nexport { z } from "./a.ts";\n',
    "src/index.test.ts": 'import "./index.ts";\n',
  });
  assert.deepEqual(
    selectTests(root, [change("src/a.ts")]),
    selected(["src/index.test.ts"]),
  );
});

test("an import type makes an edge", async (t) => {
  const root = await repository(t, {
    "src/a.ts": "export type A = string;\n",
    "src/b.test.ts": 'let value: import("./a.ts").A = "";\nvalue;\n',
  });
  assert.deepEqual(
    selectTests(root, [change("src/a.ts")]),
    selected(["src/b.test.ts"]),
  );
});

test("a dynamic import with a string literal makes an edge", async (t) => {
  const root = await repository(t, {
    "src/a.ts": EMPTY_MODULE,
    "src/b.test.ts": 'await import("./a.ts");\n',
  });
  assert.deepEqual(
    selectTests(root, [change("src/a.ts")]),
    selected(["src/b.test.ts"]),
  );
});

test("a URL with a string literal makes a file edge", async (t) => {
  const root = await repository(t, {
    "static/data.json": "{}",
    "src/b.test.ts": 'new URL("../static/data.json", import.meta.url);\n',
  });
  assert.deepEqual(
    selectTests(root, [change("static/data.json")]),
    selected(["src/b.test.ts"]),
  );
});

test("a URL that ends with a slash makes a prefix edge", async (t) => {
  const root = await repository(t, {
    "static/dir/one.json": "{}",
    "static/other.json": "{}",
    "src/b.test.ts": 'new URL("../static/dir/", import.meta.url);\n',
  });
  assert.deepEqual(
    selectTests(root, [change("static/dir/one.json")]),
    selected(["src/b.test.ts"]),
  );
  assert.deepEqual(selectTests(root, [change("static/other.json")]), NONE);
});

test("a template URL makes a prefix edge to the text before the substitution", async (t) => {
  const root = await repository(t, {
    "static/dir/part-one.json": "{}",
    "static/dir/other.json": "{}",
    "src/b.test.ts":
      "const n = 'x';\nnew URL(`../static/dir/part-${n}.json`, import.meta.url);\n",
  });
  assert.deepEqual(
    selectTests(root, [change("static/dir/part-one.json")]),
    selected(["src/b.test.ts"]),
  );
  assert.deepEqual(selectTests(root, [change("static/dir/other.json")]), NONE);
});

test("a prefix edge to the repository root is dropped", async (t) => {
  const root = await repository(t, {
    "src/lone.ts": EMPTY_MODULE,
    "static/data.json": "{}",
    "src/b.test.ts":
      'new URL("../", import.meta.url);\nnew URL("../../", import.meta.url);\nnew URL("./", import.meta.url);\n',
  });
  assert.deepEqual(selectTests(root, [change("static/data.json")]), NONE);
});

test("the data table makes static/openapi/ an input of static/openapi.yaml", async (t) => {
  const root = await repository(t, {
    "static/openapi.yaml": "openapi: 3.1.0\n",
    "static/openapi/part.yaml": "a: 1\n",
    "src/spec.test.ts": 'new URL("../static/openapi.yaml", import.meta.url);\n',
  });
  assert.deepEqual(
    selectTests(root, [change("static/openapi/part.yaml")]),
    selected(["src/spec.test.ts"]),
  );
});

test("a deleted module selects each importer that still names it", async (t) => {
  const root = await repository(t, {
    "src/b.test.ts": 'import "./gone.ts";\n',
  });
  assert.deepEqual(
    selectTests(root, [change("src/gone.ts", DELETED)]),
    selected(["src/b.test.ts"]),
  );
});

test("a rename selects the importers of the previous path", async (t) => {
  const root = await repository(t, {
    "src/new.ts": EMPTY_MODULE,
    "src/b.test.ts": 'import "./old.ts";\n',
  });
  assert.deepEqual(
    selectTests(root, [change("src/new.ts", RENAMED, "src/old.ts")]),
    selected(["src/b.test.ts"]),
  );
});

test("an untracked file is a graph node", async (t) => {
  const root = await repository(t, {
    "src/new.ts": EMPTY_MODULE,
    "src/new.test.ts": 'import "./new.ts";\n',
  });
  assert.deepEqual(
    selectTests(root, [change("src/new.ts", ADDED)]),
    selected(["src/new.test.ts"]),
  );
});

for (const input of GLOBAL_INPUTS) {
  test(`the global input ${input} selects all unit tests`, async (t) => {
    const root = await repository(t, {
      "src/a.test.ts": TEST_BODY,
      "src/apps/server/e2e-one.test.ts": TEST_BODY,
      "scripts/test-path.test.mjs": TEST_BODY,
    });
    const expected = {
      selection: "all",
      reason: `global input: ${input}`,
      tests: ["scripts/test-path.test.mjs", "src/a.test.ts"],
      excluded_e2e: ["src/apps/server/e2e-one.test.ts"],
    };
    assert.deepEqual(selectTests(root, [change(input)]), expected);
    assert.deepEqual(
      selectTests(root, [change("src/a.test.ts", RENAMED, input)]),
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
    selectTests(
      root,
      paths.map((path) => change(path)),
    ),
    NONE,
  );
});

test("a nested markdown file is not inert", async (t) => {
  const root = await repository(t, { "src/a.test.ts": TEST_BODY });
  const result = selectTests(root, [change("src/notes.md", ADDED)]);
  assert.equal(result.selection, "all");
  assert.equal(result.reason, "unknown path: src/notes.md");
});

test("an inert path that an edge names selects the importer", async (t) => {
  const root = await repository(t, {
    "docs/spec.md": "text\n",
    "src/b.test.ts": 'new URL("../docs/spec.md", import.meta.url);\n',
  });
  assert.deepEqual(
    selectTests(root, [change("docs/spec.md")]),
    selected(["src/b.test.ts"]),
  );
});

test("an unknown path selects all unit tests", async (t) => {
  const root = await repository(t, {
    "src/a.test.ts": TEST_BODY,
    "src/apps/server/e2e-one.test.ts": TEST_BODY,
  });
  assert.deepEqual(selectTests(root, [change("Makefile", ADDED)]), {
    selection: "all",
    reason: "unknown path: Makefile",
    tests: ["src/a.test.ts"],
    excluded_e2e: ["src/apps/server/e2e-one.test.ts"],
  });
});

test("the reason holds at most 256 UTF-8 bytes", async (t) => {
  const root = await repository(t, { "src/a.test.ts": TEST_BODY });
  const path = `é${"é".repeat(LONG_NAME_LENGTH)}`;
  const { reason } = selectTests(root, [change(path, ADDED)]);
  assert.ok(Buffer.byteLength(reason) <= REASON_MAX_BYTES);
  assert.ok(reason.startsWith("unknown path: é"));
  assert.ok(!reason.includes("\uFFFD"));
});

test("an e2e path is excluded and never selected", async (t) => {
  const root = await repository(t, {
    "src/a.ts": EMPTY_MODULE,
    "src/apps/server/e2e-one.test.ts": 'import "../../a.ts";\n',
    "src/a.test.ts": 'import "./a.ts";\n',
  });
  assert.deepEqual(
    selectTests(root, [change("src/a.ts")]),
    selected(["src/a.test.ts"], ["src/apps/server/e2e-one.test.ts"]),
  );
});

test("a test that imports startTestSshd is e2e", async (t) => {
  const root = await repository(t, {
    [SSHD_MODULE]: "export function startTestSshd() {}\n",
    "src/repository/ssh.test.ts":
      'import { startTestSshd } from "./test-sshd.ts";\nstartTestSshd();\n',
    "src/repository/alias.test.ts":
      'import { startTestSshd as start } from "./test-sshd.ts";\nstart();\n',
    "src/repository/plain.test.ts": 'import "./test-sshd.ts";\n',
  });
  assert.deepEqual(
    selectTests(root, [change(SSHD_MODULE)]),
    selected(
      ["src/repository/plain.test.ts"],
      ["src/repository/alias.test.ts", "src/repository/ssh.test.ts"],
    ),
  );
});

test("a changed unit test selects itself", async (t) => {
  const root = await repository(t, {
    "src/a.test.ts": TEST_BODY,
    "scripts/affected-tests.test.mjs": TEST_BODY,
  });
  assert.deepEqual(
    selectTests(root, [change("src/a.test.ts")]),
    selected(["src/a.test.ts"]),
  );
  assert.deepEqual(
    selectTests(root, [change("scripts/affected-tests.test.mjs")]),
    selected(["scripts/affected-tests.test.mjs"]),
  );
});

test("a change that reaches no unit test gives none", async (t) => {
  const root = await repository(t, {
    "src/a.ts": EMPTY_MODULE,
    "src/a.test.ts": TEST_BODY,
  });
  assert.deepEqual(selectTests(root, [change("src/a.ts")]), NONE);
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
    selectTests(root, [change("src/tracking/contract.ts")]),
    selected(["src/tracking/service.test.ts"]),
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
    selectTests(root, [change("src/worker/service.test.ts")]),
    selected(["src/worker/service.test.ts"]),
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
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
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
  return { ...result, report: JSON.parse(lines.at(-1)) };
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
  const ids = result.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
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
  assert.deepEqual(result.report, {
    version: 1,
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

test("the none selection gives empty lists and the exit code 0", async (t) => {
  const root = await fixture(t, { "src/a.test.ts": FAILING_TEST });
  const reportPath = join(root, "report.json");
  const result = runEntry(root, [], {
    KANTHORD_CHANGES: await changesFile(root, [change("docs/readme.txt")]),
    KANTHORD_AFFECTED_REPORT: reportPath,
  });
  assert.equal(result.status, SUCCESS);
  assert.deepEqual(result.report, {
    version: 1,
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

test("each selection of the selector passes affectedReportSchema", async (t) => {
  const root = await fixture(t, {
    "src/a.ts": EMPTY_MODULE,
    "src/a.test.ts": `import "./a.ts";\n${PASSING_TEST}`,
  });
  const changesBySelection = {
    related: [change("src/a.ts")],
    all: [change("package.json")],
    none: [change("docs/readme.txt")],
  };
  for (const [selection, files] of Object.entries(changesBySelection)) {
    const result = runEntry(root, [], {
      KANTHORD_CHANGES: await changesFile(root, files),
    });
    assert.equal(result.status, SUCCESS);
    assert.equal(result.report.selection, selection);
    assert.ok(affectedReportSchema.parse(result.report));
  }
});
