import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLedger,
  withLedger,
  takeTemporaryDirectory,
  takeDirectory,
  takeImage,
  removeTree,
} from "./resources.ts";
import type { Resource } from "./resources.ts";
import type { CommandRecord } from "./command.ts";
import type { PodmanExecutor } from "./driver/podman.ts";

function resource(
  kind: Resource["kind"],
  id: string,
  events: string[],
  fail = false,
): Resource {
  return {
    kind,
    id,
    release: async () => {
      if (fail) {
        throw new Error("boom");
      }
      events.push(id);
    },
  };
}

test("releaseAll releases resources in reverse take order", async () => {
  const events: string[] = [];
  const ledger = createLedger();

  ledger.take(resource("process", "a", events));
  ledger.take(resource("process", "b", events));
  ledger.take(resource("process", "c", events));

  await ledger.releaseAll();

  assert.deepEqual(events, ["c", "b", "a"]);
});

test("a rejecting release() on the middle resource still releases the others and is reported", async () => {
  const events: string[] = [];
  const ledger = createLedger();

  ledger.take(resource("process", "a", events));
  ledger.take(resource("process", "b", events, true));
  ledger.take(resource("process", "c", events));

  const failures = await ledger.releaseAll();

  assert.deepEqual(events, ["c", "a"]);
  assert.deepEqual(failures, [
    { kind: "process", id: "b", reason: "Error: boom" },
  ]);
});

test("releaseAll called twice releases each resource once", async () => {
  const events: string[] = [];
  const ledger = createLedger();

  ledger.take(resource("process", "a", events));
  ledger.take(resource("process", "b", events));

  await ledger.releaseAll();
  const second = await ledger.releaseAll();

  assert.deepEqual(events, ["b", "a"]);
  assert.deepEqual(second, []);
});

test("withLedger resolves the body's value and an empty failure list, and releases its resources", async () => {
  const events: string[] = [];

  const result = await withLedger(async (ledger) => {
    ledger.take(resource("process", "a", events));
    return 7;
  });

  assert.deepEqual(result, { value: 7, failures: [] });
  assert.deepEqual(events, ["a"]);
});

test("withLedger rethrows the body's exact error object and still releases", async () => {
  const events: string[] = [];
  const thrown = new Error("body failed");

  let caught: unknown;
  try {
    await withLedger(async (ledger) => {
      ledger.take(resource("process", "a", events));
      throw thrown;
    });
    assert.fail("expected withLedger to reject");
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, thrown);
  assert.deepEqual(events, ["a"]);
});

test("withLedger attaches cleanupFailures to the body's error without replacing the cause", async () => {
  const events: string[] = [];
  const thrown = new Error("body failed");

  let caught: unknown;
  try {
    await withLedger(async (ledger) => {
      ledger.take(resource("process", "a", events, true));
      throw thrown;
    });
    assert.fail("expected withLedger to reject");
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, thrown);
  assert.deepEqual((caught as { cleanupFailures?: unknown }).cleanupFailures, [
    { kind: "process", id: "a", reason: "Error: boom" },
  ]);
});

test("a pre-installed foreign SIGINT listener survives withLedger", async () => {
  const foreign = () => {};
  process.on("SIGINT", foreign);

  try {
    await withLedger(async () => "done");

    assert.ok(process.listeners("SIGINT").includes(foreign));
  } finally {
    process.removeListener("SIGINT", foreign);
  }
});

test("taken() returns handles carrying only kind and id, no release key", async () => {
  const ledger = createLedger();
  ledger.take(resource("process", "a", []));

  const taken = ledger.taken();

  assert.deepEqual(taken, [{ kind: "process", id: "a" }]);
  assert.equal(Object.hasOwn(taken[0] as object, "release"), false);
});

test("withLedger leaves SIGINT and SIGTERM listener counts unchanged after it resolves", async () => {
  const before = {
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM"),
  };

  await withLedger(async () => "done");

  assert.equal(process.listenerCount("SIGINT"), before.sigint);
  assert.equal(process.listenerCount("SIGTERM"), before.sigterm);
});

test("takeTemporaryDirectory creates the directory, takes it with kind directory, and releaseAll removes it", async () => {
  const ledger = createLedger();

  const directory = await takeTemporaryDirectory(ledger, "kanthord-e2e-x-");

  assert.ok(existsSync(directory));
  assert.deepEqual(ledger.taken(), [{ kind: "directory", id: directory }]);

  await ledger.releaseAll();

  assert.equal(existsSync(directory), false);
});

test("takeDirectory takes a caller-created path without creating anything, and releaseAll removes it", async () => {
  const ledger = createLedger();
  const directory = await mkdtemp(join(tmpdir(), "kanthord-e2e-adopt-"));

  takeDirectory(ledger, directory);

  assert.deepEqual(ledger.taken(), [{ kind: "directory", id: directory }]);

  await ledger.releaseAll();

  assert.equal(existsSync(directory), false);
});

test("takeDirectory takes a path that does not exist without creating it, and releaseAll leaves it absent", async () => {
  const ledger = createLedger();
  const directory = await mkdtemp(join(tmpdir(), "kanthord-e2e-absent-"));
  await rm(directory, { recursive: true, force: true });

  takeDirectory(ledger, directory);

  assert.equal(existsSync(directory), false);
  assert.deepEqual(ledger.taken(), [{ kind: "directory", id: directory }]);

  await ledger.releaseAll();

  assert.equal(existsSync(directory), false);
});

test("releasing a directory that was already removed produces no ResourceFailure", async () => {
  const ledger = createLedger();
  const directory = await mkdtemp(join(tmpdir(), "kanthord-e2e-gone-"));

  takeDirectory(ledger, directory);
  await rm(directory, { recursive: true, force: true });

  const failures = await ledger.releaseAll();

  assert.deepEqual(failures, []);
});

test("takeImage takes one handle of kind image, and releaseAll issues exactly podman image rm --force <id>", async () => {
  const ledger = createLedger();
  const calls: (readonly string[])[] = [];
  const execute: PodmanExecutor = async (argv): Promise<CommandRecord> => {
    calls.push(argv);
    return { argv, cwd: process.cwd(), exitCode: 0, stdout: "", stderr: "" };
  };

  takeImage(ledger, execute, "sha256:abc");

  assert.deepEqual(ledger.taken(), [{ kind: "image", id: "sha256:abc" }]);

  await ledger.releaseAll();

  assert.deepEqual(calls, [["podman", "image", "rm", "--force", "sha256:abc"]]);
});

test("removeTree removes a populated directory, and resolves without throwing on an absent path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kanthord-e2e-removetree-"));
  await writeFile(join(directory, "a-file"), "content");

  await removeTree(directory);

  assert.equal(existsSync(directory), false);

  await assert.doesNotReject(removeTree(join(directory, "still-absent")));
});
