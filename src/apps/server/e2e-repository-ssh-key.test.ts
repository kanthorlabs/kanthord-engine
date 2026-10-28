import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { credentialAnswerSchema } from "../../custody/contract.ts";
import { errorSchema } from "../../kernel/errors.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import { temporary } from "../../kernel/test-support.ts";
import { environment, kanthord } from "./cli-test-support.ts";
import { gatewayFixture } from "./test-support.ts";
import { createIdempotencyKey } from "../../kernel/identity.ts";

const SSH_KEY_PATH = "/api/repository/credential/ssh/key";
const NAME = "deploy";
const FIRST_REVISION = 1;
const NEXT_REVISION = 2;
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EMPTY_OUTPUT = "";
const OPENSSH_LABEL = "OPENSSH PRIVATE KEY";
const CREDENTIAL = ["repository", "credential"];
const NAME_CONFLICT_CODE = "credential.name.conflict";
const PUBLIC_KEY_PATTERN = /^ssh-ed25519 [A-Za-z0-9+/]+=* kanthord-deploy$/;

async function setup(t: TestContext) {
  const fixture = await gatewayFixture(t);
  const headers = (key?: string) => ({
    authorization: `Bearer ${fixture.token}`,
    "content-type": "application/json",
    ...(key === undefined ? {} : { "idempotency-key": key }),
  });
  const env = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  return { fixture, headers, env };
}

function publicKeyOf(answer: unknown): string {
  const metadata = credentialAnswerSchema.parse(answer).revisions[0]!
    .metadata as { public_key: string };
  return metadata.public_key;
}

test("a repeated Idempotency-Key of ssh_key_create answers the same record without a second key", async (t) => {
  const { fixture, headers } = await setup(t);
  const key = createIdempotencyKey();
  const create = () =>
    fixture.request(SSH_KEY_PATH, {
      method: HttpMethod.Post,
      headers: headers(key),
      body: JSON.stringify({ name: NAME }),
    });
  const first = await create();
  assert.equal(first.status, HttpStatus.OK);
  const text = await first.text();
  assert.ok(!text.includes(OPENSSH_LABEL));
  const second = await create();
  assert.equal(second.status, HttpStatus.OK);
  assert.deepEqual(JSON.parse(await second.text()), JSON.parse(text));
  assert.match(publicKeyOf(JSON.parse(text)), PUBLIC_KEY_PATTERN);
  const conflict = await fixture.request(SSH_KEY_PATH, {
    method: HttpMethod.Post,
    headers: headers(createIdempotencyKey()),
    body: JSON.stringify({ name: NAME }),
  });
  assert.equal(conflict.status, HttpStatus.Conflict);
  assert.equal(
    errorSchema.parse(await conflict.json()).error.code,
    NAME_CONFLICT_CODE,
  );
  const unkeyed = await fixture.request(SSH_KEY_PATH, {
    method: HttpMethod.Post,
    headers: headers(),
    body: JSON.stringify({ name: "other" }),
  });
  assert.equal(unkeyed.status, HttpStatus.BadRequest);
});

test("the CLI creates and rotates an SSH key and prints no private key", async (t) => {
  const { env } = await setup(t);
  const created = await kanthord([...CREDENTIAL, "ssh-key-create", NAME], env);
  assert.equal(created.code, EXIT_SUCCESS, created.stderr);
  assert.equal(created.stderr, EMPTY_OUTPUT);
  assert.ok(!created.stdout.includes(OPENSSH_LABEL));
  const record = JSON.parse(created.stdout);
  assert.ok(record.idempotency_key);
  assert.equal(record.revisions[0].revision, FIRST_REVISION);
  const first = record.revisions[0].metadata.public_key;
  assert.match(first, PUBLIC_KEY_PATTERN);
  const stale = await kanthord(
    [
      ...CREDENTIAL,
      "ssh-key-rotate",
      NAME,
      "--expected-revision",
      String(NEXT_REVISION),
    ],
    env,
  );
  assert.equal(stale.code, EXIT_FAILURE);
  assert.ok(
    stale.stderr.startsWith("credential.revision.conflict:"),
    stale.stderr,
  );
  const rotated = await kanthord(
    [
      ...CREDENTIAL,
      "ssh-key-rotate",
      NAME,
      "--expected-revision",
      String(FIRST_REVISION),
    ],
    env,
  );
  assert.equal(rotated.code, EXIT_SUCCESS, rotated.stderr);
  assert.ok(!rotated.stdout.includes(OPENSSH_LABEL));
  const next = JSON.parse(rotated.stdout);
  assert.equal(next.revisions[0].revision, NEXT_REVISION);
  assert.notEqual(next.revisions[0].metadata.public_key, first);
});

test("the CLI refuses an invalid expected revision and each SSH key command without a token", async (t) => {
  const { env } = await setup(t);
  const invalid = await kanthord(
    [...CREDENTIAL, "ssh-key-rotate", NAME, "--expected-revision", "zero"],
    env,
  );
  assert.equal(invalid.code, EXIT_FAILURE);
  assert.ok(
    invalid.stderr.startsWith(
      "cli.repository.credential.ssh_key_rotate.invalid_revision:",
    ),
    invalid.stderr,
  );
  const unauthenticated = { ...env, KANTHORD_TOKEN: undefined };
  for (const [args, command] of [
    [["ssh-key-create", NAME], "ssh_key_create"],
    [
      ["ssh-key-rotate", NAME, "--expected-revision", String(FIRST_REVISION)],
      "ssh_key_rotate",
    ],
  ] as const) {
    const result = await kanthord([...CREDENTIAL, ...args], unauthenticated);
    assert.equal(result.code, EXIT_FAILURE);
    assert.ok(
      result.stderr.startsWith(
        `cli.repository.credential.${command}.token_required:`,
      ),
      result.stderr,
    );
  }
});
