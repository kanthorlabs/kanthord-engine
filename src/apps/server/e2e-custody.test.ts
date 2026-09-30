import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ulid } from "ulid";
import type { CredentialAnswer } from "../../custody/contract.ts";
import { writePrivate } from "../../kernel/files.ts";
import { temporary } from "../../kernel/test-support.ts";
import { environment, kanthord } from "./cli-support.ts";
import { gatewayFixture } from "./test-support.ts";

const ExitCode = { Success: 0, Failure: 1 } as const;
const EMPTY_OUTPUT = "";
const FIRST_REVISION = 1;
const SECOND_REVISION = 2;
const INVALID_REVISION = 0;
const SINGLE_REVISION_COUNT = 1;
const TWO_REVISION_COUNT = 2;
const NAME = "e2e-credential";
const ANTHROPIC = "anthropic";
const GITHUB = "github";
const OPENAI_COMPATIBLE = "openai-compatible";
const BASE_URL = "https://api.openai.com/v1";
const MODEL_ID = "gpt-4o";
const SECRET_FIELD = "secret";
const SECRET_VALUE = "e2e-custody-secret-never-print-this";
const SECRET = { key: SECRET_VALUE };
const SESSION_ID = "login_session_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LOCAL_TOKEN = "local-validation-token";

type CommandResult = Awaited<ReturnType<typeof kanthord>>;
type ListAnswer = { items: CredentialAnswer[]; nextCursor: string | null };

async function setup(t: TestContext) {
  const fixture = await gatewayFixture(t);
  const directory = temporary(t);
  const env = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  assert.ok(env.KANTHORD_ENDPOINT.startsWith("http://127.0.0.1:"));
  assert.ok(env.KANTHORD_TOKEN);
  return { directory, env };
}

function createFile(
  directory: string,
  platform: string,
  metadata: Record<string, unknown> | null = null,
): string {
  assert.ok(directory.startsWith("/"));
  assert.ok([ANTHROPIC, GITHUB, OPENAI_COMPATIBLE].includes(platform));
  const path = join(directory, "create.json");
  writePrivate(
    path,
    JSON.stringify({ name: NAME, platform, metadata, secret: SECRET }),
  );
  return path;
}

function rotateFile(directory: string): string {
  assert.ok(directory.startsWith("/"));
  assert.ok(SECRET.key);
  const path = join(directory, "rotate.json");
  writePrivate(
    path,
    JSON.stringify({ expectedRevision: FIRST_REVISION, secret: SECRET }),
  );
  return path;
}

function success<T = CredentialAnswer>(result: CommandResult): T {
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(result.stderr, EMPTY_OUTPUT);
  assert.ok(!result.stdout.includes(SECRET_VALUE), "stdout leaked the secret");
  return JSON.parse(result.stdout, (key, value: unknown) => {
    assert.notEqual(key, SECRET_FIELD, "JSON contains a secret field");
    assert.notEqual(value, SECRET_VALUE, "JSON contains the secret value");
    return value;
  });
}

function refusal(result: CommandResult, code: string): void {
  assert.equal(result.code, ExitCode.Failure, result.stderr);
  assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
  assert.equal(result.stdout, EMPTY_OUTPUT);
}

test("E01.1 create and get an anthropic credential without secrets", async (t) => {
  const { directory, env } = await setup(t);
  const file = createFile(directory, ANTHROPIC);
  const created = success(
    await kanthord(["credential", "create", "--file", file], env),
  );
  assert.equal(created.name, NAME);
  assert.equal(created.platform, ANTHROPIC);
  assert.ok(created.revisions[0]);
  assert.equal(created.revisions[0].revision, FIRST_REVISION);
  const read = success(await kanthord(["credential", "get", NAME], env));
  assert.equal(read.name, NAME);
  assert.equal(read.platform, ANTHROPIC);
  assert.ok(read.revisions[0]);
  assert.equal(read.revisions[0].revision, FIRST_REVISION);
});

test("E01.2 creating the same name with a different key conflicts", async (t) => {
  const { directory, env } = await setup(t);
  const file = createFile(directory, ANTHROPIC);
  const firstKey = ulid();
  const secondKey = ulid();
  assert.notEqual(firstKey, secondKey);
  success(
    await kanthord(
      ["credential", "create", "--file", file, "--idempotency-key", firstKey],
      env,
    ),
  );
  refusal(
    await kanthord(
      ["credential", "create", "--file", file, "--idempotency-key", secondKey],
      env,
    ),
    "credential.name.conflict",
  );
});

test("E01.3 replaying the same create key returns the original JSON", async (t) => {
  const { directory, env } = await setup(t);
  const file = createFile(directory, ANTHROPIC);
  const args = [
    "credential",
    "create",
    "--file",
    file,
    "--idempotency-key",
    ulid(),
  ];
  const created = success(await kanthord(args, env));
  const replayed = success(await kanthord(args, env));
  assert.deepEqual(replayed, created);
  const read = success(await kanthord(["credential", "get", NAME], env));
  assert.equal(read.revisions.length, SINGLE_REVISION_COUNT);
  assert.ok(read.revisions[0]);
  assert.equal(read.revisions[0].revision, FIRST_REVISION);
});

test("E01.4 list contains the created credential without secrets", async (t) => {
  const { directory, env } = await setup(t);
  const file = createFile(directory, ANTHROPIC);
  success(await kanthord(["credential", "create", "--file", file], env));
  const listed = success<ListAnswer>(
    await kanthord(["credential", "list"], env),
  );
  assert.ok(listed.items.some((item) => item.name === NAME));
  assert.equal(listed.nextCursor, null);
});

test("E01.5 list filters credentials by platform", async (t) => {
  const { directory, env } = await setup(t);
  const file = createFile(directory, ANTHROPIC);
  success(await kanthord(["credential", "create", "--file", file], env));
  const anthropic = success<ListAnswer>(
    await kanthord(["credential", "list", "--platform", ANTHROPIC], env),
  );
  assert.ok(anthropic.items.some((item) => item.name === NAME));
  const github = success<ListAnswer>(
    await kanthord(["credential", "list", "--platform", GITHUB], env),
  );
  assert.deepEqual(github.items, []);
});

test("E01.6 get refuses a nonexistent credential", async (t) => {
  const { env } = await setup(t);
  refusal(
    await kanthord(["credential", "get", "nonexistent"], env),
    "credential.credential.not_found",
  );
});

test("E01.7 rotating a github credential adds a secret-free revision", async (t) => {
  const { directory, env } = await setup(t);
  const file = createFile(directory, GITHUB);
  success(await kanthord(["credential", "create", "--file", file], env));
  success(
    await kanthord(
      ["credential", "rotate", NAME, "--file", rotateFile(directory)],
      env,
    ),
  );
  const read = success(await kanthord(["credential", "get", NAME], env));
  assert.equal(read.revisions.length, TWO_REVISION_COUNT);
  assert.ok(read.revisions[0]);
  assert.equal(read.revisions[0].revision, SECOND_REVISION);
});

const STALE_ROTATION_TIMEOUT_MS = 60000;
test(
  "E01.8 rotate refuses an observed stale expected revision",
  { timeout: STALE_ROTATION_TIMEOUT_MS },
  async (t) => {
    const { directory, env } = await setup(t);
    const file = createFile(directory, GITHUB);
    const created = success(
      await kanthord(["credential", "create", "--file", file], env),
    );
    assert.ok(created.revisions[0]);
    const observed = created.revisions[0].revision;
    const rotation = join(directory, "stale.json");
    writePrivate(
      rotation,
      JSON.stringify({ expectedRevision: observed, secret: SECRET }),
    );
    const args = ["credential", "rotate", NAME, "--file", rotation];
    success(await kanthord(args, env));
    const rotated = success(await kanthord(["credential", "get", NAME], env));
    assert.ok(rotated.revisions[0]);
    assert.notEqual(rotated.revisions[0].revision, observed);
    refusal(await kanthord(args, env), "credential.revision.conflict");
    const read = success(await kanthord(["credential", "get", NAME], env));
    assert.deepEqual(read, rotated);
  },
);

test("E01.9 updating metadata adds a model in a secret-free revision", async (t) => {
  const { directory, env } = await setup(t);
  const file = createFile(directory, OPENAI_COMPATIBLE, {
    baseUrl: BASE_URL,
    models: [],
  });
  success(await kanthord(["credential", "create", "--file", file], env));
  const metadata = join(directory, "metadata.json");
  writeFileSync(
    metadata,
    JSON.stringify({
      expectedRevision: FIRST_REVISION,
      metadata: { baseUrl: BASE_URL, models: [{ id: MODEL_ID }] },
    }),
  );
  success(
    await kanthord(
      ["credential", "update-metadata", NAME, "--file", metadata],
      env,
    ),
  );
  const read = success(await kanthord(["credential", "get", NAME], env));
  assert.equal(read.revisions.length, TWO_REVISION_COUNT);
  assert.ok(read.revisions[0]);
  assert.equal(read.revisions[0].revision, SECOND_REVISION);
  const models = read.revisions[0].metadata?.models;
  assert.ok(Array.isArray(models));
  assert.ok(models.some((model) => model.id === MODEL_ID));
});

test("E01.10 revoking revision 1 leaves revision 2 live", async (t) => {
  const { directory, env } = await setup(t);
  const file = createFile(directory, GITHUB);
  success(await kanthord(["credential", "create", "--file", file], env));
  success(
    await kanthord(
      ["credential", "rotate", NAME, "--file", rotateFile(directory)],
      env,
    ),
  );
  success(
    await kanthord(["credential", "revoke", NAME, String(FIRST_REVISION)], env),
  );
  const read = success(await kanthord(["credential", "get", NAME], env));
  const first = read.revisions.find(
    (entry) => entry.revision === FIRST_REVISION,
  );
  const second = read.revisions.find(
    (entry) => entry.revision === SECOND_REVISION,
  );
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.endedAt, null);
  assert.equal(second.endedAt, null);
});

test("E01.11 revoke refuses the newest live revision", async (t) => {
  const { directory, env } = await setup(t);
  const file = createFile(directory, GITHUB);
  success(await kanthord(["credential", "create", "--file", file], env));
  success(
    await kanthord(
      ["credential", "rotate", NAME, "--file", rotateFile(directory)],
      env,
    ),
  );
  refusal(
    await kanthord(
      ["credential", "revoke", NAME, String(SECOND_REVISION)],
      env,
    ),
    "credential.revision.newest_live",
  );
});

test("E01.12 github refuses OAuth login", async (t) => {
  const { env } = await setup(t);
  refusal(
    await kanthord(["credential", "login", GITHUB, "--name", NAME], env),
    "credential.entry.unsupported",
  );
});

test("E01.13 login-status refuses an absent session", async (t) => {
  const { env } = await setup(t);
  refusal(
    await kanthord(["credential", "login-status", SESSION_ID], env),
    "credential.login.not_found",
  );
});

test("E01.14 login-code refuses an absent session", async (t) => {
  const { env } = await setup(t);
  refusal(
    await kanthord(["credential", "login-code", SESSION_ID, "value"], env),
    "credential.login.not_found",
  );
});

test("create refuses a missing file without a server", async (t) => {
  const directory = temporary(t);
  const env = { ...environment(directory), KANTHORD_TOKEN: LOCAL_TOKEN };
  refusal(
    await kanthord(
      ["credential", "create", "--file", join(directory, "missing.json")],
      env,
    ),
    "cli.file.not_found",
  );
});

test("create refuses duplicate file options without a server", async (t) => {
  const env = { ...environment(temporary(t)), KANTHORD_TOKEN: LOCAL_TOKEN };
  refusal(
    await kanthord(["credential", "create", "--file", "a", "--file", "b"], env),
    "cli.option.duplicate",
  );
});

test("revoke refuses revision zero without a server", async (t) => {
  const env = { ...environment(temporary(t)), KANTHORD_TOKEN: LOCAL_TOKEN };
  refusal(
    await kanthord(
      ["credential", "revoke", NAME, String(INVALID_REVISION)],
      env,
    ),
    "cli.credential.revoke.invalid_revision",
  );
});

test("rotate refuses expected revision zero without a server", async (t) => {
  const directory = temporary(t);
  const env = { ...environment(directory), KANTHORD_TOKEN: LOCAL_TOKEN };
  const rotation = join(directory, "zero.json");
  writePrivate(
    rotation,
    JSON.stringify({ expectedRevision: INVALID_REVISION, secret: SECRET }),
  );
  refusal(
    await kanthord(["credential", "rotate", NAME, "--file", rotation], env),
    "cli.file.schema_invalid",
  );
});

test("login refuses an invalid mode without a server", async (t) => {
  const env = { ...environment(temporary(t)), KANTHORD_TOKEN: LOCAL_TOKEN };
  refusal(
    await kanthord(
      ["credential", "login", "github-copilot", "--name", NAME, "--mode", "tv"],
      env,
    ),
    "cli.credential.login.invalid_mode",
  );
});
