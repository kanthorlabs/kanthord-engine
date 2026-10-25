import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import { EnvironmentFailure } from "../../scheduler/contract.ts";
import type { ExecutionEnvironment } from "../contract.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import {
  BaseHead,
  runSetup,
  SetupEnd,
  setUpHeads,
  setupEntries,
  type SetupCheckout,
} from "./environment-setup.ts";
import { headCommit } from "./local-git.ts";
import {
  RecordKind,
  SpanStatus,
  type TelemetryRecord,
} from "../../tracking/contract.ts";
import { SpanOperation, SpanRecorder } from "./telemetry.ts";
import { spanEnds } from "./test-support.ts";

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
  const base = new BaseHead(input(), join(root, "base"), entries);
  const head = await headCommit(env, checkout.directory, background, 10000);
  return { entries, base, head };
}

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
  base.dispose();
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
  const base = new BaseHead(exhausted, join(root, "base"), entries);
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
