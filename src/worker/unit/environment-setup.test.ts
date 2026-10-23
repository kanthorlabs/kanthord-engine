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
  return { source: EnvironmentSource.Stored, document };
}

function input() {
  return { env, context: background, deadline: Date.now() + 30000 };
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

test("setup reads the devcontainer file of the base head for a repository source", async (t) => {
  const { checkout } = await repository(t, {
    ".devcontainer/devcontainer.json": `{
      // repository environment
      "postCreateCommand": "touch ${SETUP_MARKER}",
    }`,
  });
  const source = setupCheckout(checkout, {
    source: EnvironmentSource.Repository,
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
    setupCheckout(none.checkout, { source: EnvironmentSource.Repository }),
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
      setupCheckout(checkout, { source: EnvironmentSource.Repository }),
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

test("the base rerun runs on the base head after its setup and is cached by commit, digest and command", async (t) => {
  const { root, checkout } = await repository(t, { file: "base" });
  await commit(checkout, "node", "node");
  const counter = join(root, "runs");
  const { base } = await prepared(
    setupCheckout(
      checkout,
      stored({ postCreateCommand: `touch ${SETUP_MARKER}` }),
    ),
    root,
  );
  const command = `echo run >> ${counter}; test -e ${SETUP_MARKER} && test ! -e node && command-absent-x`;
  assert.equal(await base.exitOf(command), COMMAND_ABSENT_EXIT);
  assert.equal(await base.exitOf(command), COMMAND_ABSENT_EXIT);
  assert.equal(readFileSync(counter, "utf8"), ONE_RUN);
  const other = await prepared(
    setupCheckout(checkout, stored({ postCreateCommand: "true" })),
    join(root, "other"),
  );
  assert.equal(await other.base.exitOf(command), FAILED_EXIT);
  assert.equal(readFileSync(counter, "utf8"), TWO_RUNS);
});
