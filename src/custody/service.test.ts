import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "pino";
import { background, CancellationContext } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
import { HealthStatus } from "../kernel/service.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { custodyOperations, CUSTODY_SERVICE_NAME } from "./contract.ts";
import { decrypt } from "./envelope.ts";
import { custodyMigrations } from "./migrations.ts";
import { Platform } from "./platforms.ts";
import { CustodyComponent } from "./service.ts";

const FIRST_REVISION = 1;
const HUMAN_ACCOUNT_ID = "alice";
const NAME_CONFLICT_CODE = "credential.name.conflict";
const key = Buffer.alloc(32, 7);
const secretValue = "private-credential-value";
const apiSecret = { key: secretValue };
const inputs = [
  {
    name: "github",
    platform: Platform.GitHub,
    secret: apiSecret,
    metadata: null,
  },
  {
    name: "anthropic",
    platform: Platform.Anthropic,
    secret: apiSecret,
    metadata: null,
  },
  {
    name: "openai",
    platform: Platform.OpenAICompatible,
    secret: apiSecret,
    metadata: { baseUrl: "https://example.com/v1", models: [] },
  },
  {
    name: "storage",
    platform: Platform.S3,
    secret: { accessKeyId: "id", secretAccessKey: secretValue },
    metadata: {
      endpoint: "https://example.com",
      bucket: "bucket",
      region: "region",
    },
  },
];

function fixture() {
  const store = new Store(IN_MEMORY_DATABASE);
  store.migrate([
    { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
  ]);
  const logs: { credentialId: string; humanIdentity: string }[] = [];
  const logger = {
    info: (record: { credentialId: string; humanIdentity: string }) =>
      logs.push(record),
  } as unknown as Logger;
  const health = new HealthRegistry();
  const component = new CustodyComponent({ envelopeKey: key, logger, health });
  const registry = new OperationRegistry();
  component.declare(registry);
  const caller: CallerContext = {
    identity: { kind: "human", accountId: "alice", name: "Alice", jti: "j" },
    context: background,
    requestId: "request",
    commit: (write) => store.transaction(write),
  };
  function invoke(
    operation: (typeof custodyOperations)[keyof typeof custodyOperations],
    input: unknown,
  ): unknown {
    const parsed = operation.input.parse(input);
    return registry.get(operation.id).handler(parsed, caller);
  }
  const create = (body: unknown) =>
    invoke(custodyOperations.create, { params: {}, query: {}, body });
  const get = (name: string) =>
    invoke(custodyOperations.get, {
      params: { credentialName: name },
      query: {},
      body: null,
    });
  const list = (query: Record<string, unknown> = {}) =>
    invoke(custodyOperations.list, { params: {}, query, body: null });
  return { store, component, registry, health, logs, create, get, list };
}

function fails(fn: () => unknown, status: number, code: string) {
  assert.throws(
    fn,
    (error) =>
      error instanceof OperationError &&
      error.status === status &&
      error.code === code,
  );
}

function noSecret(value: unknown) {
  const serialized = JSON.stringify(value);
  assert.ok(!serialized.includes('"secret"'));
  assert.ok(!serialized.includes(secretValue));
}

test("create validates platforms, schema, conflicts and encrypts each first revision", () => {
  const f = fixture();
  try {
    for (const input of inputs) {
      const answer = f.create(input) as {
        revisions: { id: string; revision: number }[];
      };
      assert.equal(answer.revisions.length, FIRST_REVISION);
      assert.equal(answer.revisions[0]!.revision, FIRST_REVISION);
      noSecret(answer);
      const row = f.store.database
        .prepare("SELECT nonce, ciphertext FROM credential WHERE id = ?")
        .get(answer.revisions[0]!.id) as { nonce: Buffer; ciphertext: Buffer };
      assert.deepEqual(
        decrypt(
          key,
          answer.revisions[0]!.id,
          input.platform,
          row.nonce,
          row.ciphertext,
        ),
        input.secret,
      );
      assert.equal(f.logs.at(-1)?.credentialId, answer.revisions[0]!.id);
      assert.equal(f.logs.at(-1)?.humanIdentity, HUMAN_ACCOUNT_ID);
    }
    const id = (f.get("github") as { revisions: { id: string }[] })
      .revisions[0]!.id;
    assert.throws(
      () => f.create(inputs[0]),
      (error) =>
        error instanceof OperationError &&
        error.status === HttpStatus.Conflict &&
        error.code === NAME_CONFLICT_CODE &&
        (error.details as { id: string }).id === id,
    );
    fails(
      () => f.create({ ...inputs[0], name: "login" }),
      HttpStatus.BadRequest,
      "credential.input.invalid",
    );
    fails(
      () =>
        f.create({
          ...inputs[2],
          name: "nonempty-models",
          metadata: { ...inputs[2]!.metadata, models: [{ id: "gpt" }] },
        }),
      HttpStatus.BadRequest,
      "credential.input.invalid",
    );
    fails(
      () => f.create({ ...inputs[0], platform: Platform.GitHubCopilot }),
      HttpStatus.BadRequest,
      "credential.entry.unsupported",
    );
    fails(
      () => f.create({ ...inputs[0], platform: "unknown" }),
      HttpStatus.BadRequest,
      "credential.platform.unsupported",
    );
    fails(
      () => f.create({ ...inputs[0], name: "invalid-secret", secret: {} }),
      HttpStatus.BadRequest,
      "credential.input.invalid",
    );
    fails(
      () => f.create({ ...inputs[0], name: "invalid-metadata", metadata: {} }),
      HttpStatus.BadRequest,
      "credential.input.invalid",
    );
    assert.ok(!JSON.stringify(f.logs).includes(secretValue));
  } finally {
    f.store.close();
  }
});

test("get orders revisions and list paginates sorted names with filters", () => {
  const f = fixture();
  try {
    for (const input of inputs) f.create(input);
    const first = f.get("github") as { revisions: { id: string }[] };
    f.store.database
      .prepare(
        "INSERT INTO credential SELECT ?, name, platform, ?, nonce, ciphertext, metadata, created_at + ?, ended_at FROM credential WHERE id = ?",
      )
      .run("credential_second", 2, 1, first.revisions[0]!.id);
    const got = f.get("github") as { revisions: { id: string }[] };
    assert.deepEqual(
      got.revisions.map((revision) => revision.id),
      ["credential_second", first.revisions[0]!.id],
    );
    noSecret(got);
    fails(
      () => f.get("missing"),
      HttpStatus.NotFound,
      "credential.credential.not_found",
    );
    const filtered = f.list({ platform: Platform.S3 }) as {
      items: { name: string }[];
    };
    assert.deepEqual(
      filtered.items.map((item) => item.name),
      ["storage"],
    );
    assert.deepEqual(
      (f.list({ platform: "invalid" }) as { items: unknown[] }).items,
      [],
    );
    const names: string[] = [];
    let cursor: string | null = null;
    do {
      const page = f.list({
        limit: 1,
        ...(cursor === null ? {} : { cursor }),
      }) as { items: { name: string }[]; nextCursor: string | null };
      noSecret(page);
      names.push(...page.items.map((item) => item.name));
      cursor = page.nextCursor;
    } while (cursor !== null && names.length < inputs.length + 1);
    assert.deepEqual(names, ["anthropic", "github", "openai", "storage"]);
    assert.equal(cursor, null);
    fails(
      () => f.list({ cursor: "%%%" }),
      HttpStatus.BadRequest,
      "system.pagination.cursor_invalid",
    );
  } finally {
    f.store.close();
  }
});

test("lifecycle reports health and joins cancellation", async () => {
  const f = fixture();
  try {
    assert.equal(
      (await f.health.check()).custody?.credential,
      HealthStatus.Unavailable,
    );
    assert.equal(await f.component.start(), null);
    assert.equal(
      (await f.health.check()).custody?.credential,
      HealthStatus.Healthy,
    );
    assert.equal(await f.component.quiesce(), null);
    assert.equal(await f.component.stop(), null);
    assert.equal(
      (await f.health.check()).custody?.credential,
      HealthStatus.Unavailable,
    );
    assert.ok((await f.component.start()) instanceof Error);
    const other = new CustodyComponent({
      envelopeKey: key,
      logger: { info() {} } as unknown as Logger,
    });
    const context = new CancellationContext();
    const running = other.run(context);
    context.cancel();
    assert.equal(await running, context.err());
  } finally {
    f.store.close();
  }
});
