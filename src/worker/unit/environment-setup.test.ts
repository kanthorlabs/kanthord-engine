import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { digest } from "../../kernel/json.ts";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import { EnvironmentFailure } from "../../scheduler/contract.ts";
import type { ExecutionEnvironment } from "../contract.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import {
  BaseHead,
  runSetup,
  type SetupCheckout,
  SetupEnd,
  setupEntries,
  setUpHeads,
} from "./environment-setup.ts";
import { commitOf, headCommit } from "./local-git.ts";
import { validRoots } from "./setup-record.ts";
import {
  RecordKind,
  SpanStatus,
  type TelemetryRecord,
} from "../../tracking/contract.ts";
import { SpanOperation, SpanRecorder } from "./telemetry.ts";
import { VerificationClass } from "./verification.ts";
import { spanEnds } from "./test-support.ts";
import { spawnedPids, survivingProcesses } from "../../agent/test-support.ts";
import { BASE_DIRECTORY, WorkspaceRoot } from "./workspace.ts";
import { PoolClass, repoKeyOf } from "./tree-pool.ts";

const env = hostEnvironment();
const IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];
const SETUP_MARKER = "setup-ran";
const FAILED_EXIT = 1;
const COMMAND_ABSENT_EXIT = 127;
const SETUP_OUTPUT = "update\ncreate\n";
const ONE_RUN = "run\n";
const TWO_RUNS = "run\nrun\n";
const MAGIC_PATH = ":lock";
const MAGIC_TEXT = "{}";
const ONE_SPAN = 1;
const ONE_CHILD = 1;
const DIGEST = "d".repeat(64);
const CLAIM = {
  execution_id: "execution_01JZ8R2B3C4D5E6F7G8H9J0K1M",
  node_id: "node_01JZ8Q0K4M6N8P0R2S4T6V8W0X",
  attempt: 1,
  trace_id: "a".repeat(32),
  root_span_id: "1".repeat(16),
};

async function commit(directory: string, path: string, content: string) {
  writeFileSync(join(directory, path), content);
  await simpleGit(directory).add(path);
  await simpleGit(directory).raw([...IDENTITY, "commit", "-m", path]);
}

async function repository(t: TestContext, files: Record<string, string>) {
  const root = temporary(t);
  const origin = join(root, "origin");
  mkdirSync(origin);
  await simpleGit(origin).raw(["init", "-b", "main"]);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(origin, path, ".."), { recursive: true });
    await commit(origin, path, content);
  }
  const checkout = join(root, "checkout");
  await simpleGit(root).clone(origin, checkout);
  await simpleGit(checkout).raw(["checkout", "-b", "kanthord/node"]);
  return { root, origin, checkout };
}

function setupCheckout(
  directory: string,
  environment: ExecutionEnvironment,
): SetupCheckout {
  return {
    directory,
    repository: {
      binding_id: createIdentity("binding"),
      name: "repo",
      strategy: { base_branch: "main" },
      environment,
    },
  };
}

function stored(document: Record<string, unknown>): ExecutionEnvironment {
  return { source: EnvironmentSource.Stored, document, digest: DIGEST };
}

function input() {
  return {
    env,
    context: background,
    deadline: Date.now() + 30000,
    spans: null,
  };
}

async function prepared(checkout: SetupCheckout, root: string) {
  const entries = await setupEntries(input(), [checkout]);
  const base = new BaseHead(
    input(),
    { directory: join(root, "base") },
    entries,
  );
  const head = await headCommit(env, checkout.directory, background, 10000);
  return { entries, base, head };
}

function setupRecordPath(checkout: string): string {
  return join(checkout, ".git", "kanthord-setup.json");
}

function setupRecordText(checkout: string): string | null {
  const path = setupRecordPath(checkout);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function setupRecord(checkout: string): unknown {
  const text = setupRecordText(checkout);
  return text === null ? null : JSON.parse(text);
}

async function setUp(checkout: string, document: Record<string, unknown>) {
  return await runSetup(
    input(),
    await setupEntries(input(), [setupCheckout(checkout, stored(document))]),
  );
}

const ROOTS_SETUP = {
  postCreateCommand: "mkdir -p deps && echo x > deps/a && echo y > out.txt",
};
const KEPT_SETUP = {
  postCreateCommand: "test -e deps || (mkdir deps && echo x > deps/a)",
};
const NO_DEPS_SETUP = { postCreateCommand: "test ! -e deps" };
const NO_COMMAND_SETUP = {};
const PLAIN_SETUP = { postCreateCommand: "true" };
const TRACKED_TEXT = "tracked";

test("a passing setup records the paths that it creates as setup roots", async (t) => {
  const { checkout } = await repository(t, { ".gitignore": "*.log\n" });
  writeFileSync(join(checkout, "earlier.log"), "x");
  assert.deepEqual(await setUp(checkout, ROOTS_SETUP), {
    end: SetupEnd.Pass,
  });
  assert.deepEqual(setupRecord(checkout), {
    digest: digest(ROOTS_SETUP),
    roots: ["deps/", "out.txt"],
  });
});

test("a second setup keeps a recorded root that it does not create again", async (t) => {
  const { checkout } = await repository(t, { file: "base" });
  assert.deepEqual(await setUp(checkout, KEPT_SETUP), { end: SetupEnd.Pass });
  assert.deepEqual(await setUp(checkout, KEPT_SETUP), { end: SetupEnd.Pass });
  assert.deepEqual(setupRecord(checkout), {
    digest: digest(KEPT_SETUP),
    roots: ["deps/"],
  });
});

test("a setup on a changed environment removes the recorded roots before its commands", async (t) => {
  const { checkout } = await repository(t, { file: "base" });
  assert.deepEqual(await setUp(checkout, ROOTS_SETUP), { end: SetupEnd.Pass });
  assert.deepEqual(await setUp(checkout, NO_DEPS_SETUP), {
    end: SetupEnd.Pass,
  });
  assert.equal(existsSync(join(checkout, "out.txt")), false);
  assert.deepEqual(setupRecord(checkout), {
    digest: digest(NO_DEPS_SETUP),
    roots: [],
  });
});

test("a changed environment with no setup command removes the recorded roots", async (t) => {
  const { checkout } = await repository(t, { file: "base" });
  assert.deepEqual(await setUp(checkout, ROOTS_SETUP), { end: SetupEnd.Pass });
  assert.deepEqual(await setUp(checkout, NO_COMMAND_SETUP), {
    end: SetupEnd.Pass,
  });
  assert.equal(existsSync(join(checkout, "deps")), false);
  assert.equal(existsSync(join(checkout, "out.txt")), false);
  assert.equal(setupRecord(checkout), null);
});

test("a record with a root outside the checkout removes nothing outside the checkout", async (t) => {
  const { root, checkout } = await repository(t, { ".gitignore": "deps/\n" });
  const outside = join(root, "outside");
  writeFileSync(outside, "x");
  mkdirSync(join(checkout, "deps"));
  writeFileSync(join(checkout, "deps", "a"), "x");
  writeFileSync(
    setupRecordPath(checkout),
    JSON.stringify({ digest: "earlier", roots: ["../outside", "deps/"] }),
  );
  assert.deepEqual(await setUp(checkout, NO_COMMAND_SETUP), {
    end: SetupEnd.Pass,
  });
  assert.equal(existsSync(outside), true);
  assert.equal(existsSync(join(checkout, "deps")), false);
  assert.equal(setupRecord(checkout), null);
});

test("a changed environment keeps a recorded root that holds a tracked path", async (t) => {
  const { checkout } = await repository(t, { "deps/tracked": TRACKED_TEXT });
  writeFileSync(
    setupRecordPath(checkout),
    JSON.stringify({ digest: "earlier", roots: ["deps/"] }),
  );
  assert.deepEqual(await setUp(checkout, PLAIN_SETUP), { end: SetupEnd.Pass });
  assert.equal(
    readFileSync(join(checkout, "deps", "tracked"), "utf8"),
    TRACKED_TEXT,
  );
});

test("a changed environment keeps a recorded root under a symlink to a directory outside the checkout", async (t) => {
  const { root, checkout } = await repository(t, { ".gitignore": "link\n" });
  const outside = join(root, "outside");
  mkdirSync(join(outside, "sub"), { recursive: true });
  writeFileSync(join(outside, "sub", "a"), TRACKED_TEXT);
  symlinkSync(outside, join(checkout, "link"));
  writeFileSync(
    setupRecordPath(checkout),
    JSON.stringify({ digest: "earlier", roots: ["link/sub", "link/"] }),
  );
  assert.deepEqual(await setUp(checkout, PLAIN_SETUP), { end: SetupEnd.Pass });
  assert.equal(readFileSync(join(outside, "sub", "a"), "utf8"), TRACKED_TEXT);
  assert.deepEqual(setupRecord(checkout), {
    digest: digest(PLAIN_SETUP),
    roots: [],
  });
});

test("a recorded root under a .git segment in any letter case is not valid", async (t) => {
  const { checkout } = await repository(t, { file: "base" });
  assert.deepEqual(
    await validRoots(
      { env, directory: checkout, context: background, deadlineMs: 10000 },
      [".GIT/objects", ".Git/", "deps/"],
    ),
    ["deps/"],
  );
});

test("a failed setup keeps the earlier record", async (t) => {
  const { checkout } = await repository(t, { file: "base" });
  const guarded = {
    postCreateCommand:
      "mkdir -p deps && test ! -e stop && if test -e touch; then echo changed > file; fi",
  };
  assert.deepEqual(await setUp(checkout, guarded), { end: SetupEnd.Pass });
  const earlier = setupRecordText(checkout);
  writeFileSync(join(checkout, "stop"), "x");
  assert.equal((await setUp(checkout, guarded)).end, SetupEnd.Failed);
  assert.equal(setupRecordText(checkout), earlier);
  rmSync(join(checkout, "stop"));
  writeFileSync(join(checkout, "touch"), "x");
  assert.equal((await setUp(checkout, guarded)).end, SetupEnd.Failed);
  assert.equal(setupRecordText(checkout), earlier);
});

test("setup runs the commands of a stored environment in the checkout", async (t) => {
  const { checkout } = await repository(t, { file: "base" });
  const result = await runSetup(
    input(),
    await setupEntries(input(), [
      setupCheckout(
        checkout,
        stored({
          updateContentCommand: `echo update > ${SETUP_MARKER}`,
          postCreateCommand: ["sh", "-c", `echo create >> ${SETUP_MARKER}`],
        }),
      ),
    ]),
  );
  assert.deepEqual(result, { end: SetupEnd.Pass });
  assert.equal(
    readFileSync(join(checkout, SETUP_MARKER), "utf8"),
    SETUP_OUTPUT,
  );
});

test("setup runs the commands of a detected and a universal environment in the checkout", async (t) => {
  for (const source of [
    EnvironmentSource.Detected,
    EnvironmentSource.Universal,
  ]) {
    const { checkout } = await repository(t, { file: "base" });
    const result = await runSetup(
      input(),
      await setupEntries(input(), [
        setupCheckout(checkout, {
          source,
          document: {
            updateContentCommand: `echo update > ${SETUP_MARKER}`,
            postCreateCommand: ["sh", "-c", `echo create >> ${SETUP_MARKER}`],
          },
        }),
      ]),
    );
    assert.deepEqual(result, { end: SetupEnd.Pass });
    assert.equal(
      readFileSync(join(checkout, SETUP_MARKER), "utf8"),
      SETUP_OUTPUT,
    );
  }
});

test("setup reads the devcontainer file of the base head for a repository source", async (t) => {
  const { checkout } = await repository(t, {
    ".devcontainer/devcontainer.json": `{
      // repository environment
      "postCreateCommand": "touch ${SETUP_MARKER}",
    }`,
  });
  const source = setupCheckout(checkout, {
    source: EnvironmentSource.Repository,
    digest: DIGEST,
  });
  const [entry] = await setupEntries(input(), [source]);
  assert.deepEqual(entry?.environment, {
    postCreateCommand: `touch ${SETUP_MARKER}`,
  });
  assert.deepEqual(await runSetup(input(), [entry!]), {
    end: SetupEnd.Pass,
  });
  assert.equal(existsSync(join(checkout, SETUP_MARKER)), true);
  const none = await repository(t, { file: "base" });
  const [absent] = await setupEntries(input(), [
    setupCheckout(none.checkout, {
      source: EnvironmentSource.Repository,
      digest: DIGEST,
    }),
  ]);
  assert.equal(absent?.environment, null);
  assert.equal(
    (await setupEntries(input(), [setupCheckout(none.checkout, null)]))[0]
      ?.environment,
    null,
  );
});

test("an invalid devcontainer file of the base head stops with an environment failure", async (t) => {
  const { checkout } = await repository(t, {
    ".devcontainer/devcontainer.json": '{"postCreateCommand": 1}',
  });
  await assert.rejects(
    setupEntries(input(), [
      setupCheckout(checkout, {
        source: EnvironmentSource.Repository,
        digest: DIGEST,
      }),
    ]),
    (error) =>
      error instanceof ExecutionStop &&
      error.reason === EndReason.EnvironmentFailed &&
      error.code === EnvironmentFailure.SetupFailed,
  );
});

test("a setup failure on the base head is an environment failure", async (t) => {
  const { root, checkout } = await repository(t, { file: "base" });
  const { entries, base, head } = await prepared(
    setupCheckout(checkout, stored({ postCreateCommand: "exit 3" })),
    root,
  );
  await assert.rejects(
    setUpHeads(input(), entries, base, [head]),
    (error) =>
      error instanceof ExecutionStop &&
      error.reason === EndReason.EnvironmentFailed &&
      error.code === EnvironmentFailure.SetupFailed &&
      /exit 3/.test(error.detail ?? ""),
  );
});

test("a setup failure on the node head that passes on the base head is a code failure", async (t) => {
  const { root, checkout } = await repository(t, { file: "base" });
  await commit(checkout, "broken", "node");
  const { entries, base, head } = await prepared(
    setupCheckout(checkout, stored({ postCreateCommand: "test ! -e broken" })),
    root,
  );
  const result = await setUpHeads(input(), entries, base, [head]);
  assert.equal(result.end, SetupEnd.Failed);
  assert.ok(result.end === SetupEnd.Failed);
  assert.equal(result.run.verification.results[0]?.exit_code, FAILED_EXIT);
  await base.giveBack();
  assert.equal(existsSync(join(root, "base")), false);
});

test("a setup failure on the node head and on the base head is an environment failure", async (t) => {
  const { root, checkout } = await repository(t, { file: "base" });
  await commit(checkout, "node", "node");
  const { entries, base, head } = await prepared(
    setupCheckout(checkout, stored({ postCreateCommand: "exit 4" })),
    root,
  );
  await assert.rejects(
    setUpHeads(input(), entries, base, [head]),
    (error) =>
      error instanceof ExecutionStop &&
      error.code === EnvironmentFailure.SetupFailed,
  );
});

test("the base rerun runs on the base head after its setup and is cached within one execution only", async (t) => {
  const { root, checkout } = await repository(t, { file: "base" });
  await commit(checkout, "node", "node");
  const counter = join(root, "runs");
  const environment = stored({ postCreateCommand: `touch ${SETUP_MARKER}` });
  const { base } = await prepared(setupCheckout(checkout, environment), root);
  const command = `echo run >> ${counter}; test -e ${SETUP_MARKER} && test ! -e node && command-absent-x`;
  assert.equal(await base.exitOf(command), COMMAND_ABSENT_EXIT);
  assert.equal(await base.exitOf(command), COMMAND_ABSENT_EXIT);
  assert.equal(readFileSync(counter, "utf8"), ONE_RUN);
  const next = await prepared(
    setupCheckout(checkout, environment),
    join(root, "next"),
  );
  assert.equal(await next.base.exitOf(command), COMMAND_ABSENT_EXIT);
  assert.equal(readFileSync(counter, "utf8"), TWO_RUNS);
});

test("a run in the base head runs in the named clone at the base commit with the variables and runs again on a second call", async (t) => {
  const { root, checkout } = await repository(t, { file: "base" });
  await commit(checkout, "node", "node");
  const counter = join(root, "runs");
  const entry = setupCheckout(checkout, stored({}));
  const { base } = await prepared(entry, root);
  const baseCommit = await commitOf(
    env,
    checkout,
    "origin/main",
    background,
    10000,
  );
  const command = `echo run >> ${counter}; test ! -e node && test "$(git rev-parse HEAD)" = "$BASE_COMMIT" && test "$VARIABLE" = value`;
  const input = {
    command,
    variables: { BASE_COMMIT: baseCommit, VARIABLE: "value" },
    commandLimitMs: 10000,
  };
  const first = await base.runIn("repo", input);
  assert.equal(first?.outcome, VerificationClass.Pass);
  assert.deepEqual(first.verification.tested_input, {
    kind: "repository",
    binding_id: entry.repository.binding_id,
    commit: baseCommit,
  });
  assert.equal(
    (await base.runIn("repo", input))?.outcome,
    VerificationClass.Pass,
  );
  assert.equal(readFileSync(counter, "utf8"), TWO_RUNS);
  assert.equal(await base.commitOf("repo"), baseCommit);
});

test("a run in the base head stops with setup_failed when the base setup fails", async (t) => {
  const { root, checkout } = await repository(t, { file: "base" });
  const { base } = await prepared(
    setupCheckout(checkout, stored({ postCreateCommand: "exit 6" })),
    root,
  );
  await assert.rejects(
    base.runIn("repo", {
      command: "true",
      variables: {},
      commandLimitMs: 1000,
    }),
    (error) =>
      error instanceof ExecutionStop &&
      error.code === EnvironmentFailure.SetupFailed,
  );
});

test("the base rerun stops with setup_failed when the base setup fails", async (t) => {
  const { root, checkout } = await repository(t, { file: "base" });
  const { base } = await prepared(
    setupCheckout(checkout, stored({ postCreateCommand: "exit 6" })),
    root,
  );
  await assert.rejects(
    base.exitOf("command-absent-x"),
    (error) =>
      error instanceof ExecutionStop &&
      error.reason === EndReason.EnvironmentFailed &&
      error.code === EnvironmentFailure.SetupFailed,
  );
});

test("the base rerun answers no exit when the budget ends in the base setup", async (t) => {
  const { root, checkout } = await repository(t, { file: "base" });
  const entry = setupCheckout(checkout, stored({ postCreateCommand: "true" }));
  const exhausted = { ...input(), exhausted: () => true };
  const entries = await setupEntries(exhausted, [entry]);
  const base = new BaseHead(
    exhausted,
    { directory: join(root, "base") },
    entries,
  );
  assert.equal(await base.exitOf("command-absent-x"), null);
});

test("a setup that changes a tracked file only on the node head is a code failure that names the path", async (t) => {
  const { root, checkout } = await repository(t, { "package-lock.json": "{}" });
  await commit(checkout, "dependency", "node");
  const { entries, base, head } = await prepared(
    setupCheckout(
      checkout,
      stored({
        postCreateCommand:
          "if test -e dependency; then echo changed > package-lock.json; fi",
      }),
    ),
    root,
  );
  const result = await setUpHeads(input(), entries, base, [head]);
  assert.ok(result.end === SetupEnd.Failed);
  assert.deepEqual(result.changed, ["package-lock.json"]);
  assert.equal(result.run.verification.results.at(-1)?.exit_code, FAILED_EXIT);
  assert.match(result.run.outputs.at(-1) ?? "", /package-lock\.json/);
  assert.equal(result.commands.length, result.run.verification.results.length);
});

test("a setup that changes a tracked file on the node head and on the base head stops with setup_failed and names the path", async (t) => {
  const { root, checkout } = await repository(t, { "package-lock.json": "{}" });
  await commit(checkout, "node", "node");
  const { entries, base, head } = await prepared(
    setupCheckout(
      checkout,
      stored({ postCreateCommand: "echo changed > package-lock.json" }),
    ),
    root,
  );
  await assert.rejects(
    setUpHeads(input(), entries, base, [head]),
    (error) =>
      error instanceof ExecutionStop &&
      error.reason === EndReason.EnvironmentFailed &&
      error.code === EnvironmentFailure.SetupFailed &&
      /package-lock\.json/.test(error.detail ?? ""),
  );
});

async function stagedAfterSetup(checkout: string): Promise<string[]> {
  await simpleGit(checkout).raw(["add", "--all"]);
  return (await simpleGit(checkout).raw(["diff", "--cached", "--name-only"]))
    .split("\n")
    .filter(Boolean);
}

test("a failed setup leaves its untracked output out of the next task commit", async (t) => {
  const { checkout } = await repository(t, { "package-lock.json": "{}" });
  for (const command of [
    "mkdir -p build && touch build/out && exit 3",
    "mkdir -p build && touch build/out && echo changed > package-lock.json",
  ]) {
    const result = await runSetup(
      input(),
      await setupEntries(input(), [
        setupCheckout(checkout, stored({ postCreateCommand: command })),
      ]),
    );
    assert.equal(result.end, SetupEnd.Failed);
    assert.deepEqual(await stagedAfterSetup(checkout), []);
  }
});

test("a tracked change restores a path that reads as pathspec magic", async (t) => {
  const { checkout } = await repository(t, { file: "base" });
  writeFileSync(join(checkout, MAGIC_PATH), MAGIC_TEXT);
  await simpleGit(checkout).raw(["--literal-pathspecs", "add", MAGIC_PATH]);
  await simpleGit(checkout).raw([...IDENTITY, "commit", "-m", MAGIC_PATH]);
  const result = await runSetup(
    input(),
    await setupEntries(input(), [
      setupCheckout(checkout, stored({ postCreateCommand: "echo x > :lock" })),
    ]),
  );
  assert.ok(result.end === SetupEnd.Failed);
  assert.deepEqual(result.changed, [MAGIC_PATH]);
  assert.equal(readFileSync(join(checkout, MAGIC_PATH), "utf8"), MAGIC_TEXT);
});

function recorded() {
  const records: TelemetryRecord[] = [];
  const spans = new SpanRecorder(CLAIM, "coder-1", {
    write: (batch) => records.push(...batch),
    flush: async () => {},
  });
  return { records, spans };
}

test("a setup run with a recorder writes one setup span with its result", async (t) => {
  const { checkout } = await repository(t, { file: "base" });
  const { records, spans } = recorded();
  const withSpans = { ...input(), spans };
  const entries = await setupEntries(withSpans, [
    setupCheckout(checkout, stored({ postCreateCommand: "true" })),
  ]);
  assert.deepEqual(await runSetup(withSpans, entries), { end: SetupEnd.Pass });
  const ends = spanEnds(records, SpanOperation.Setup);
  assert.equal(ends.length, ONE_SPAN);
  assert.equal(ends[0]?.status, SpanStatus.Ok);
  assert.deepEqual(ends[0]?.attributes, { "kanthord.setup.result": "pass" });
  const starts = records.filter((record) => "start_time" in record);
  assert.equal(
    starts[0]?.kind === RecordKind.Span &&
      starts[0].attributes?.["kanthord.setup.entry_count"],
    ONE_SPAN,
  );
});

test("a failed setup script writes a setup span with the result failed and the status Ok", async (t) => {
  const { checkout } = await repository(t, { file: "base" });
  const { records, spans } = recorded();
  const withSpans = { ...input(), spans };
  const entries = await setupEntries(withSpans, [
    setupCheckout(checkout, stored({ postCreateCommand: "exit 1" })),
  ]);
  assert.equal((await runSetup(withSpans, entries)).end, SetupEnd.Failed);
  const ends = spanEnds(records, SpanOperation.Setup);
  assert.equal(ends.length, ONE_SPAN);
  assert.equal(ends[0]?.status, SpanStatus.Ok);
  assert.deepEqual(ends[0]?.attributes, { "kanthord.setup.result": "failed" });
});

test("a setup run with no recorder writes no span", async (t) => {
  const { checkout } = await repository(t, { file: "base" });
  const { records } = recorded();
  const entries = await setupEntries(input(), [
    setupCheckout(checkout, stored({ postCreateCommand: "true" })),
  ]);
  assert.deepEqual(await runSetup(input(), entries), { end: SetupEnd.Pass });
  assert.deepEqual(records, []);
});

test("a background child of a setup command is dead before the first verification", async (t) => {
  const { root, checkout } = await repository(t, { file: "base" });
  const childFile = join(root, "setup-child");
  const entries = await setupEntries(input(), [
    setupCheckout(
      checkout,
      stored({
        postCreateCommand: `sleep 30 >/dev/null 2>&1 & echo $! > ${childFile}`,
      }),
    ),
  ]);
  assert.deepEqual(await runSetup(input(), entries), { end: SetupEnd.Pass });
  const spawned = spawnedPids(t, [
    { type: "text", text: readFileSync(childFile, "utf8") },
  ]);
  assert.equal(spawned.length, ONE_CHILD);
  assert.deepEqual(await survivingProcesses(spawned), []);
});

const TREE_DELETED = "tree deleted";
const INVALID_PERMISSIONS = "system.files.invalid_permissions";
const OPEN_MODE = 0o755;
const ROOT_USER = 0;
const ONE_TREE = 1;
const READ_ONLY_MODE = 0o500;
const STRAY_FILE = "stray.txt";
const BASE_PURPOSE = "base";

interface LogRecord {
  msg: string;
  fields: Record<string, unknown>;
}

async function poolFixture(t: TestContext) {
  const { root, origin, checkout } = await repository(t, { file: "base" });
  const workspaces = WorkspaceRoot.open(temporary(t));
  const logs: LogRecord[] = [];
  const entry = setupCheckout(checkout, stored(KEPT_SETUP));
  const baseHead = async (nodeId: string, environment = entry) =>
    new BaseHead(
      input(),
      {
        directory: join(workspaces.nodeKey(nodeId), BASE_DIRECTORY),
        trees: {
          workspaces,
          nodeId,
          addresses: new Map([[environment.repository.name, origin]]),
          log: (msg, fields) => logs.push({ msg, fields }),
        },
      },
      await setupEntries(input(), [environment]),
    );
  const tree = (nodeId: string) =>
    join(workspaces.nodeKey(nodeId), BASE_DIRECTORY, entry.repository.name);
  const commandTrees = () =>
    workspaces.pool
      .trees()
      .map(({ path }) => path)
      .filter(
        (path) =>
          basename(dirname(path)) === PoolClass.Command &&
          basename(dirname(dirname(path))) === repoKeyOf(origin),
      );
  const prepared = () =>
    logs
      .filter(({ fields }) => fields.purpose === BASE_PURPOSE)
      .map(({ msg, fields }) => [msg, fields.source]);
  return {
    root,
    origin,
    checkout,
    workspaces,
    logs,
    entry,
    baseHead,
    tree,
    commandTrees,
    prepared,
  };
}

function objectInodes(directory: string): Set<number> {
  const inodes = new Set<number>();
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const entry = join(path, name);
      const stats = lstatSync(entry);
      if (stats.isDirectory()) walk(entry);
      else inodes.add(stats.ino);
    }
  };
  walk(join(directory, ".git", "objects"));
  return inodes;
}

test("a second base head of the same repository reuses the tree and keeps each file of a setup root", async (t) => {
  const h = await poolFixture(t);
  const first = createIdentity("node");
  const base = await h.baseHead(first);
  assert.deepEqual(await base.setup(), { end: SetupEnd.Pass });
  const marker = statSync(join(h.tree(first), "deps", "a"));
  writeFileSync(join(h.tree(first), STRAY_FILE), "x");
  await base.giveBack();
  const second = createIdentity("node");
  const next = await h.baseHead(second);
  assert.deepEqual(await next.setup(), { end: SetupEnd.Pass });
  const kept = statSync(join(h.tree(second), "deps", "a"));
  assert.equal(kept.ino, marker.ino);
  assert.equal(kept.mtimeMs, marker.mtimeMs);
  assert.equal(existsSync(join(h.tree(second), STRAY_FILE)), false);
  assert.equal(
    (await headCommit(env, h.tree(second), background, 10000)).trim(),
    await commitOf(env, h.checkout, "origin/main", background, 10000),
  );
  assert.deepEqual(h.prepared(), [
    ["tree prepared", "clone"],
    ["tree prepared", "pool"],
  ]);
  await next.giveBack();
});

test("a base head gives its tree back to the command class", async (t) => {
  const h = await poolFixture(t);
  const nodeId = createIdentity("node");
  const base = await h.baseHead(nodeId);
  assert.deepEqual(await base.setup(), { end: SetupEnd.Pass });
  await base.giveBack();
  assert.equal(h.commandTrees().length, ONE_TREE);
  assert.equal(
    existsSync(join(h.workspaces.nodeKey(nodeId), BASE_DIRECTORY)),
    false,
  );
});

test("a fresh base head tree shares no object file with the agent checkout", async (t) => {
  const h = await poolFixture(t);
  const nodeId = createIdentity("node");
  const base = await h.baseHead(nodeId);
  assert.deepEqual(await base.setup(), { end: SetupEnd.Pass });
  const checkout = objectInodes(h.checkout);
  assert.deepEqual(
    [...objectInodes(h.tree(nodeId))].filter((ino) => checkout.has(ino)),
    [],
  );
  await base.giveBack();
});

test("a fresh base head checks out a moved base commit that no local branch of the checkout holds", async (t) => {
  const h = await poolFixture(t);
  await commit(h.origin, "moved", "moved");
  await simpleGit(h.checkout).fetch("origin");
  const moved = await commitOf(
    env,
    h.checkout,
    "origin/main",
    background,
    10000,
  );
  const nodeId = createIdentity("node");
  const base = await h.baseHead(nodeId);
  assert.deepEqual(await base.setup(), { end: SetupEnd.Pass });
  assert.equal(await headCommit(env, h.tree(nodeId), background, 10000), moved);
  await base.giveBack();
});

test("a base head gives back nothing when its setup never ran", async (t) => {
  const h = await poolFixture(t);
  const nodeId = createIdentity("node");
  mkdirSync(dirname(h.tree(nodeId)), { recursive: true });
  await simpleGit().raw([
    "clone",
    "--no-local",
    "--",
    h.origin,
    h.tree(nodeId),
  ]);
  const base = await h.baseHead(nodeId);
  await base.giveBack();
  assert.deepEqual(h.commandTrees(), []);
  assert.equal(existsSync(join(h.tree(nodeId), ".git")), true);
});

test("a base head preparation gives a crash leftover back and takes it", async (t) => {
  const h = await poolFixture(t);
  const nodeId = createIdentity("node");
  mkdirSync(dirname(h.tree(nodeId)), { recursive: true });
  await simpleGit().raw([
    "clone",
    "--no-local",
    "--",
    h.origin,
    h.tree(nodeId),
  ]);
  const leftover = statSync(join(h.tree(nodeId), ".git")).ino;
  const base = await h.baseHead(nodeId);
  assert.deepEqual(await base.setup(), { end: SetupEnd.Pass });
  assert.equal(statSync(join(h.tree(nodeId), ".git")).ino, leftover);
  assert.deepEqual(h.prepared(), [["tree prepared", "pool"]]);
  await base.giveBack();
});

test("a base head preparation removes a leftover entry with a current name that is not a tree", async (t) => {
  const h = await poolFixture(t);
  const nodeId = createIdentity("node");
  mkdirSync(dirname(h.tree(nodeId)), { recursive: true });
  writeFileSync(h.tree(nodeId), "x");
  const base = await h.baseHead(nodeId);
  assert.deepEqual(await base.setup(), { end: SetupEnd.Pass });
  assert.equal(existsSync(join(h.tree(nodeId), ".git")), true);
  assert.deepEqual(h.prepared(), [["tree prepared", "clone"]]);
  await base.giveBack();
});

test("a base head does not follow a symbolic link that replaces the base directory", async (t) => {
  const h = await poolFixture(t);
  const nodeId = createIdentity("node");
  const outside = join(h.root, "outside");
  const outsideTree = join(outside, h.entry.repository.name);
  mkdirSync(outside);
  await simpleGit().raw(["clone", "--no-local", "--", h.origin, outsideTree]);
  const directory = dirname(h.tree(nodeId));
  mkdirSync(dirname(directory), { recursive: true });
  symlinkSync(outside, directory);
  const base = await h.baseHead(nodeId);
  assert.deepEqual(await base.setup(), { end: SetupEnd.Pass });
  assert.equal(lstatSync(directory).isDirectory(), true);
  assert.equal(existsSync(join(outsideTree, ".git")), true);
  rmSync(directory, { recursive: true, force: true });
  symlinkSync(outside, directory);
  await base.giveBack();
  assert.equal(existsSync(join(outsideTree, ".git")), true);
  assert.equal(existsSync(directory), false);
  assert.deepEqual(h.commandTrees(), []);
});

test("a base head tree that the give cannot keep is deleted and logs tree deleted", async (t) => {
  if (process.getuid?.() === ROOT_USER)
    return t.skip("root bypasses the mode check");
  const h = await poolFixture(t);
  const nodeId = createIdentity("node");
  const base = await h.baseHead(nodeId);
  assert.deepEqual(await base.setup(), { end: SetupEnd.Pass });
  chmodSync(join(h.tree(nodeId), ".git"), OPEN_MODE);
  await base.giveBack();
  assert.deepEqual(h.commandTrees(), []);
  assert.equal(existsSync(h.tree(nodeId)), false);
  assert.deepEqual(
    h.logs
      .filter(({ msg }) => msg === TREE_DELETED)
      .map(({ fields }) => [fields.path, fields.code]),
    [[h.tree(nodeId), INVALID_PERMISSIONS]],
  );
});

test("a base head give-back that cannot remove the base directory logs tree deleted and does not throw", async (t) => {
  if (process.getuid?.() === ROOT_USER)
    return t.skip("root bypasses the mode check");
  const h = await poolFixture(t);
  const nodeId = createIdentity("node");
  const base = await h.baseHead(nodeId);
  assert.deepEqual(await base.setup(), { end: SetupEnd.Pass });
  const directory = dirname(h.tree(nodeId));
  const locked = join(directory, "locked");
  mkdirSync(locked);
  writeFileSync(join(locked, "file"), "x");
  chmodSync(locked, READ_ONLY_MODE);
  try {
    await base.giveBack();
  } finally {
    chmodSync(locked, OPEN_MODE);
  }
  assert.equal(h.commandTrees().length, ONE_TREE);
  assert.deepEqual(
    h.logs
      .filter(({ msg }) => msg === TREE_DELETED)
      .map(({ fields }) => fields.path),
    [directory],
  );
});

test("a base head whose preparation fails gives back without a throw", async (t) => {
  const h = await poolFixture(t);
  const nodeId = createIdentity("node");
  const base = await h.baseHead(nodeId);
  rmSync(h.checkout, { recursive: true, force: true });
  await assert.rejects(base.setup());
  await base.giveBack();
  assert.deepEqual(h.commandTrees(), []);
});
