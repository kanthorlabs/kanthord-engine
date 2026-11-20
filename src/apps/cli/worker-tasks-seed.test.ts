import assert from "node:assert/strict";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { temporary } from "../../kernel/test-support.ts";
import { TasksErrorCode, writeSeed } from "../worker/index.ts";
import { diagnosticOf, seedFixture } from "./tasks-test-support.ts";

const CONTAINER_CANARY = "seed-container-canary-0123456789";
const REMOTE_CANARY = "seed-remote-canary-0123456789";
const BUILD_CANARY = "seed-build-canary-0123456789";
const SEED_FILE = "seed.json";
const PRIVATE_FILE_MODE = 0o600;
const MODE_BITS = 0o777;
const TARGET_TEXT = "target";

async function environmentSeed(t: Parameters<typeof seedFixture>[0]) {
  const fixture = await seedFixture(t, (seed) => {
    const setup = seed.setup as { repositories: Record<string, unknown>[] };
    setup.repositories = setup.repositories.map((repository) => ({
      ...repository,
      environment: {
        source: "detected",
        document: {
          build: { dockerfile: "Dockerfile", args: { CANARY: BUILD_CANARY } },
          containerEnv: { CANARY: CONTAINER_CANARY },
          remoteEnv: { CANARY: REMOTE_CANARY },
        },
      },
    }));
  });
  return fixture.seed;
}

test("writeSeed removes containerEnv, remoteEnv and build.args, and writes seed.json with mode 0600 and no temporary file", async (t) => {
  const seed = await environmentSeed(t);
  const folder = join(temporary(t), "seed");
  writeSeed(folder, seed);
  const file = join(folder, SEED_FILE);
  const text = readFileSync(file, "utf8");
  for (const canary of [CONTAINER_CANARY, REMOTE_CANARY, BUILD_CANARY])
    assert.equal(text.includes(canary), false, canary);
  const written = JSON.parse(text) as {
    setup: { repositories: { environment: { document: unknown } }[] };
  };
  assert.deepEqual(written.setup.repositories[0]!.environment.document, {
    build: { dockerfile: "Dockerfile" },
  });
  assert.equal(statSync(file).mode & MODE_BITS, PRIVATE_FILE_MODE);
  assert.deepEqual(readdirSync(folder), [SEED_FILE]);
});

test("writeSeed refuses an output folder or a seed.json that is a symbolic link and writes no target", async (t) => {
  const seed = await environmentSeed(t);
  const root = temporary(t);
  const target = join(root, "target");
  mkdirSync(target);
  const linkedFolder = join(root, "linked-folder");
  symlinkSync(target, linkedFolder);
  const refusedFolder = await diagnosticOf(
    Promise.resolve().then(() => writeSeed(linkedFolder, seed)),
  );
  assert.equal(refusedFolder.code, TasksErrorCode.OutputExists);
  assert.deepEqual(readdirSync(target), []);
  const folder = join(root, "seed");
  mkdirSync(folder);
  const targetFile = join(root, "target.json");
  writeFileSync(targetFile, TARGET_TEXT);
  symlinkSync(targetFile, join(folder, SEED_FILE));
  const refusedFile = await diagnosticOf(
    Promise.resolve().then(() => writeSeed(folder, seed)),
  );
  assert.equal(refusedFile.code, TasksErrorCode.OutputExists);
  assert.equal(readFileSync(targetFile, "utf8"), TARGET_TEXT);
});

test("writeSeed deletes its temporary file when the rename onto seed.json fails", async (t) => {
  const seed = await environmentSeed(t);
  const folder = join(temporary(t), "seed");
  mkdirSync(join(folder, SEED_FILE), { recursive: true });
  writeFileSync(join(folder, SEED_FILE, TARGET_TEXT), TARGET_TEXT);
  assert.throws(() => writeSeed(folder, seed));
  assert.deepEqual(readdirSync(folder), [SEED_FILE]);
});
