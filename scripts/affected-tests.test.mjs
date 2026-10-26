import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { GLOBAL_INPUTS, INERT_INPUTS, selectTests } from "./affected-tests.mjs";

const MODIFIED = "modified";
const ADDED = "added";
const DELETED = "deleted";
const RENAMED = "renamed";
const REASON_MAX_BYTES = 256;
const LONG_NAME_LENGTH = 400;
const EMPTY_MODULE = "export {};\n";
const TEST_BODY = 'import test from "node:test";\n';
const SSHD_MODULE = "src/repository/test-sshd.ts";

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
  return { selection: "selected", reason: null, tests, excluded_e2e };
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
