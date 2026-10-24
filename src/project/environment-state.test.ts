import assert from "node:assert/strict";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalJSON } from "../kernel/json.ts";
import { temporary } from "../kernel/test-support.ts";
import {
  EnvironmentTarget,
  ProofFiles,
  ProofPhase,
  classifyProof,
  environmentDigest,
  environmentPath,
  environmentTagOf,
  type CommandResult,
  type EnvironmentDigestInput,
  type ProofFile,
} from "./environment-state.ts";

const MIXED_IDENTITY = "repository:github:Acme/My_App";
const MIXED_PATH = "repository/github/acme/my-app";
const EMPTY_PART_IDENTITY = "repository:gitlab:Group/Sub/__";
const EMPTY_PART_PATH = "repository/gitlab/group/sub/x";
const DOT_IDENTITY = "repository:github:Acme/.Todo_App";
const DOT_PATH = "repository/github/acme/todo-app";
const SETUP_FAILED = "setup_failed";
const SLEEP_COMMAND = "sleep 999";
const SUM = "a".repeat(64);
const LONG_PATH_LENGTH = 197;
const LONG_PATH_KEPT = 180;
const TAIL_LIMIT = 4096;
const PRIVATE_MODE = 0o600;
const MODE_MASK = 0o777;

function input(
  override: Partial<EnvironmentDigestInput> = {},
): EnvironmentDigestInput {
  return {
    resource_identity: "repository:github:acme/app",
    target: EnvironmentTarget.Image,
    source: "repository",
    document: { image: "base" },
    files: [{ path: "a", state: "present", text: "x" }],
    base_image: "sha256:1",
    slot_image: "sha256:2",
    secrets: [],
    version: "1.0.0",
    ...override,
  };
}

function result(
  phase: ProofPhase,
  command: string,
  exit_code: number | null,
  override: Partial<CommandResult> = {},
): CommandResult {
  return {
    phase,
    command,
    exit_code,
    timed_out: false,
    output: "",
    ...override,
  };
}

function proofFile(sum: string, override: Partial<ProofFile> = {}): ProofFile {
  return {
    digest: sum,
    outcome: "passed",
    class: null,
    origin: "onboarding",
    execution_id: null,
    command: null,
    exit_code: null,
    tail: "",
    reproduce: null,
    checks: [{ command: "make test", exit_code: 2 }],
    repairs: 0,
    ended_at: 1,
    ...override,
  };
}

test("an environment path sanitizes each part of the resource identity", () => {
  assert.equal(environmentPath(MIXED_IDENTITY), MIXED_PATH);
  assert.equal(environmentPath(EMPTY_PART_IDENTITY), EMPTY_PART_PATH);
  assert.equal(environmentPath(DOT_IDENTITY), DOT_PATH);
});

test("an environment path above 200 characters keeps 180 characters and a hash", () => {
  const identity = `repository:gitlab:${"a".repeat(242)}`;
  const path = environmentPath(identity);
  assert.equal(path.length, LONG_PATH_LENGTH);
  assert.match(path, /^repository\/gitlab\/a+-[0-9a-f]{16}$/);
  assert.equal(
    path.slice(0, LONG_PATH_KEPT),
    `repository/gitlab/${"a".repeat(LONG_PATH_KEPT - "repository/gitlab/".length)}`,
  );
  assert.notEqual(path, environmentPath(`${identity}b`));
});

test("an environment path of a long identity never ends a part with a separator", () => {
  const path = environmentPath(`repository:gitlab:${"group/".repeat(60)}app`);
  assert.equal(path.length, LONG_PATH_LENGTH);
  assert.doesNotMatch(path, /[-/]-/);
  assert.doesNotMatch(path, /\/-/);
});

test("an environment tag names the image path and the digest", () => {
  assert.equal(
    environmentTagOf("repository:github:Acme/.Todo_App", SUM),
    `localhost/kanthord-env/repository/github/acme/todo-app:${SUM}`,
  );
  assert.equal(
    environmentTagOf("repository:gitlab:Group/Sub/__", SUM),
    `localhost/kanthord-env/repository/gitlab/group/sub/x:${SUM}`,
  );
});

test("the environment digest changes with each input and ignores the key order", () => {
  const first = environmentDigest(input());
  assert.match(first, /^[0-9a-f]{64}$/);
  const reordered: EnvironmentDigestInput = {
    version: "1.0.0",
    secrets: [],
    slot_image: "sha256:2",
    base_image: "sha256:1",
    files: [{ text: "x", state: "present", path: "a" }],
    document: { image: "base" },
    source: "repository",
    target: EnvironmentTarget.Image,
    resource_identity: "repository:github:acme/app",
  };
  assert.equal(environmentDigest(reordered), first);
  for (const other of [
    input({ resource_identity: "repository:github:acme/api" }),
    input({ target: EnvironmentTarget.Host }),
    input({ source: "stored" }),
    input({ document: { image: "other" } }),
    input({ files: [{ path: "a", state: "present", text: "y" }] }),
    input({ base_image: "sha256:3" }),
    input({ slot_image: null }),
    input({ version: "2.0.0" }),
  ])
    assert.notEqual(environmentDigest(other), first);
});

const REGISTRY_SECRET = {
  variable: "REGISTRY_AUTH",
  credential: "registry-auth",
  revision: 1,
};
const NPM_SECRET = {
  variable: "NPM_TOKEN",
  credential: "npm-token",
  revision: 3,
};

test("the environment digest changes with the revision of a secret and with no secret", () => {
  const first = environmentDigest(input({ secrets: [REGISTRY_SECRET] }));
  assert.notEqual(
    environmentDigest(
      input({ secrets: [{ ...REGISTRY_SECRET, revision: 2 }] }),
    ),
    first,
  );
  assert.notEqual(environmentDigest(input()), first);
});

test("the environment digest ignores the order of the secrets", () => {
  assert.equal(
    environmentDigest(input({ secrets: [REGISTRY_SECRET, NPM_SECRET] })),
    environmentDigest(input({ secrets: [NPM_SECRET, REGISTRY_SECRET] })),
  );
});

test("the canonical JSON of the digest input holds the variable, the credential and the revision of a secret only", () => {
  const text = canonicalJSON(input({ secrets: [REGISTRY_SECRET] }));
  assert.ok(
    text.includes(
      '"secrets":[{"credential":"registry-auth","revision":1,"variable":"REGISTRY_AUTH"}]',
    ),
  );
});

test("a proof of commands that all end with exit 0 passes", () => {
  assert.deepEqual(
    classifyProof([
      result(ProofPhase.Setup, "npm ci", 0),
      result(ProofPhase.Check, "npm test", 0),
    ]),
    {
      outcome: "passed",
      class: null,
      command: null,
      exit_code: null,
      tail: "",
      checks: [],
    },
  );
});

test("a failed setup command fails the proof with its output", () => {
  const verdict = classifyProof([
    result(ProofPhase.Setup, "npm ci", 0),
    result(ProofPhase.Setup, "npm run build", 1, { output: "boom" }),
    result(ProofPhase.Check, "missing", 127),
  ]);
  assert.deepEqual(verdict, {
    outcome: "failed",
    class: "setup_failed",
    command: "npm run build",
    exit_code: 1,
    tail: "boom",
    checks: [],
  });
});

test("a setup command that exceeds its limit fails the proof", () => {
  const verdict = classifyProof([
    result(ProofPhase.Setup, SLEEP_COMMAND, null, { timed_out: true }),
  ]);
  assert.equal(verdict.class, SETUP_FAILED);
  assert.equal(verdict.command, SLEEP_COMMAND);
});

test("a check that ends with exit 127 fails the proof", () => {
  const verdict = classifyProof([
    result(ProofPhase.Check, "make test", 2),
    result(ProofPhase.Check, "pytest", 127, { output: "not found" }),
  ]);
  assert.deepEqual(verdict, {
    outcome: "failed",
    class: "command_absent",
    command: "pytest",
    exit_code: 127,
    tail: "not found",
    checks: [],
  });
});

test("a check that ends with another exit code joins the red baseline", () => {
  assert.deepEqual(
    classifyProof([
      result(ProofPhase.Check, "make test", 2),
      result(ProofPhase.Check, "make lint", 0),
      result(ProofPhase.Check, "make slow", null, { timed_out: true }),
    ]),
    {
      outcome: "passed",
      class: null,
      command: null,
      exit_code: null,
      tail: "",
      checks: [
        { command: "make test", exit_code: 2 },
        { command: "make slow", exit_code: null },
      ],
    },
  );
});

test("the tail keeps the last 4096 bytes of the output", () => {
  const output = `${"a".repeat(100)}${"b".repeat(TAIL_LIMIT)}`;
  const verdict = classifyProof([result(ProofPhase.Setup, "x", 1, { output })]);
  assert.equal(verdict.tail, "b".repeat(TAIL_LIMIT));
});

test("proof files write, read, list and remove", (t) => {
  const root = temporary(t);
  const files = new ProofFiles(root);
  const path = "repository/github/acme/app";
  const other = "repository/github/acme/app/sub";
  const sum = "b".repeat(64);
  const second = "c".repeat(64);
  assert.equal(files.read(path, sum), null);
  assert.deepEqual(files.digests(path), []);
  assert.deepEqual(files.paths(), []);
  const file = proofFile(sum);
  files.write(path, file);
  files.write(path, proofFile(second));
  files.write(other, proofFile(sum));
  assert.deepEqual(files.read(path, sum), file);
  assert.equal(
    statSync(join(root, path, `${sum}.json`)).mode & MODE_MASK,
    PRIVATE_MODE,
  );
  assert.deepEqual(
    readdirSync(join(root, path)).filter((name) => name.endsWith(".tmp")),
    [],
  );
  assert.deepEqual(files.digests(path).sort(), [sum, second].sort());
  assert.deepEqual(files.paths().sort(), [path, other].sort());
  files.remove(path, second);
  assert.deepEqual(files.digests(path), [sum]);
  files.removePath(path);
  assert.deepEqual(files.digests(path), []);
  assert.deepEqual(files.digests(other), [sum]);
  assert.deepEqual(files.paths(), [other]);
  files.removePath(other);
  assert.deepEqual(files.paths(), []);
});

test("a proof file that fails the schema reads as absent", (t) => {
  const root = temporary(t);
  const files = new ProofFiles(root);
  const path = "repository/github/acme/app";
  const sum = "d".repeat(64);
  files.write(path, proofFile(sum));
  writeFileSync(
    join(root, path, `${sum}.json`),
    JSON.stringify({ ...proofFile(sum), extra: 1 }),
  );
  assert.equal(files.read(path, sum), null);
  writeFileSync(
    join(root, path, `${sum}.json`),
    JSON.stringify({ ...proofFile(sum), repairs: -1 }),
  );
  assert.equal(files.read(path, sum), null);
});
