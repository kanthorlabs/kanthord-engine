import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "pino";
import { background, CancellationContext } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
import { HealthStatus } from "../kernel/service.ts";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import {
  custodyOperations,
  CUSTODY_SERVICE_NAME,
  type CredentialMetadataFn,
  type CustodySuitabilityFn,
  type AgentProvidersDependentOnFn,
  type BindingsNamingFn,
  type EnablementsDependentOnModelFn,
} from "./contract.ts";
import { decrypt } from "./envelope.ts";
import { custodyMigrations } from "./migrations.ts";
import { Platform } from "./platforms.ts";
import { CustodyComponent } from "./service.ts";

const FIRST_REVISION = 1;
const HUMAN_ACCOUNT_ID = "alice";
const NAME_CONFLICT_CODE = "credential.name.conflict";
const REVISION_CONFLICT_CODE = "credential.revision.conflict";
const CREDENTIAL_NOT_FOUND_CODE = "credential.credential.not_found";
const PLATFORM_MISMATCH_CODE = "credential.platform.mismatch";
const MODEL_IN_USE_CODE = "credential.metadata.model_in_use";
const REMOVED_MODEL = "removed";
const KEPT_MODEL = "kept";
const DEPENDENT_AGENT = "dependent-agent";
const RemovalMode = {
  MetadataEdit: "metadata edit",
  Rotation: "rotation",
} as const;
const NEXT_REVISION = FIRST_REVISION + 1;
const THIRD_REVISION = NEXT_REVISION + 1;
const ROTATED_BASE_URL = "https://other.example/v1";
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

function fixture(
  collaborations: {
    agentProvidersDependentOn?: AgentProvidersDependentOnFn;
    bindingsNaming?: BindingsNamingFn;
    enablementsDependentOnModel?: EnablementsDependentOnModelFn;
  } = {},
) {
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
  const component = new CustodyComponent({
    envelopeKey: key,
    logger,
    health,
    agentProvidersDependentOn:
      collaborations.agentProvidersDependentOn ?? (() => []),
    bindingsNaming: collaborations.bindingsNaming ?? (() => []),
    enablementsDependentOnModel:
      collaborations.enablementsDependentOnModel ?? (() => []),
  });
  const registry = new OperationRegistry();
  component.declare(registry);
  let lastTransaction: Transaction | undefined;
  const caller: CallerContext = {
    identity: { kind: "human", accountId: "alice", name: "Alice", jti: "j" },
    context: background,
    requestId: "request",
    commit: (write) =>
      store.transaction((tx) => {
        lastTransaction = tx;
        return write(tx);
      }),
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
  const rotate = (name: string, body: unknown) =>
    invoke(custodyOperations.rotate, {
      params: { credentialName: name },
      query: {},
      body,
    });
  const updateMetadata = (name: string, body: unknown) =>
    invoke(custodyOperations.update_metadata, {
      params: { credentialName: name },
      query: {},
      body,
    });
  const revoke = (name: string, revision: number) =>
    invoke(custodyOperations.revoke, {
      params: { credentialName: name, revision },
      query: {},
      body: null,
    });
  return {
    store,
    component,
    lastTransaction: () => lastTransaction,
    registry,
    health,
    logs,
    create,
    get,
    list,
    rotate,
    updateMetadata,
    revoke,
  };
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

test("rotate copies or replaces metadata, allows new base URL and guards revisions", () => {
  const f = fixture();
  try {
    f.create(inputs[3]);
    const copied = f.rotate("storage", {
      expectedRevision: FIRST_REVISION,
      secret: inputs[3]!.secret,
    }) as { revisions: { id: string; revision: number; metadata: unknown }[] };
    assert.deepEqual(copied.revisions[0]!.metadata, inputs[3]!.metadata);
    assert.equal(copied.revisions[0]!.revision, NEXT_REVISION);
    noSecret(copied);
    const replacement = { ...inputs[3]!.metadata, bucket: "other" };
    const replaced = f.rotate("storage", {
      expectedRevision: NEXT_REVISION,
      secret: inputs[3]!.secret,
      metadata: replacement,
    }) as { revisions: { id: string; revision: number; metadata: unknown }[] };
    assert.deepEqual(replaced.revisions[0]!.metadata, replacement);
    assert.equal(replaced.revisions[0]!.revision, THIRD_REVISION);
    noSecret(replaced);
    assert.throws(
      () =>
        f.rotate("storage", {
          expectedRevision: FIRST_REVISION,
          secret: apiSecret,
        }),
      (error) =>
        error instanceof OperationError &&
        error.status === HttpStatus.Conflict &&
        error.code === REVISION_CONFLICT_CODE &&
        (error.details as { revision: number }).revision === THIRD_REVISION,
    );
    f.create(inputs[2]);
    const changed = f.rotate("openai", {
      expectedRevision: FIRST_REVISION,
      secret: apiSecret,
      metadata: {
        baseUrl: ROTATED_BASE_URL,
        models: [{ id: "new" }],
      },
    }) as { revisions: { id: string; metadata: { baseUrl: string } }[] };
    assert.equal(changed.revisions[0]!.metadata.baseUrl, ROTATED_BASE_URL);
    noSecret(changed);
    fails(
      () =>
        f.rotate("missing", {
          expectedRevision: FIRST_REVISION,
          secret: apiSecret,
        }),
      HttpStatus.NotFound,
      "credential.credential.not_found",
    );
    fails(
      () =>
        f.rotate("storage", { expectedRevision: THIRD_REVISION, secret: {} }),
      HttpStatus.BadRequest,
      "credential.input.invalid",
    );
    assert.equal(f.logs.at(-1)?.credentialId, changed.revisions[0]!.id);
    assert.equal(f.logs.at(-1)?.humanIdentity, HUMAN_ACCOUNT_ID);
    assert.ok(!JSON.stringify(f.logs).includes(secretValue));
  } finally {
    f.store.close();
  }
});

test("two rotations with the same expected revision reject the second", () => {
  const f = fixture();
  try {
    f.create(inputs[0]);
    noSecret(
      f.rotate("github", {
        expectedRevision: FIRST_REVISION,
        secret: apiSecret,
      }),
    );
    fails(
      () =>
        f.rotate("github", {
          expectedRevision: FIRST_REVISION,
          secret: apiSecret,
        }),
      HttpStatus.Conflict,
      REVISION_CONFLICT_CODE,
    );
  } finally {
    f.store.close();
  }
});

test("metadata edits re-encrypt under new identity and enforce base URL and revision", () => {
  const f = fixture();
  try {
    f.create(inputs[2]);
    const metadata = { ...inputs[2]!.metadata, models: [{ id: "added" }] };
    const answer = f.updateMetadata("openai", {
      expectedRevision: FIRST_REVISION,
      metadata,
    }) as { revisions: { id: string; revision: number; metadata: unknown }[] };
    assert.equal(answer.revisions[0]!.revision, NEXT_REVISION);
    assert.deepEqual(answer.revisions[0]!.metadata, metadata);
    assert.notEqual(answer.revisions[0]!.id, answer.revisions[1]!.id);
    const row = f.store.database
      .prepare("SELECT id, nonce, ciphertext FROM credential WHERE id = ?")
      .get(answer.revisions[0]!.id) as {
      id: string;
      nonce: Buffer;
      ciphertext: Buffer;
    };
    assert.deepEqual(
      decrypt(
        key,
        row.id,
        Platform.OpenAICompatible,
        row.nonce,
        row.ciphertext,
      ),
      apiSecret,
    );
    noSecret(answer);
    fails(
      () =>
        f.updateMetadata("openai", {
          expectedRevision: NEXT_REVISION,
          metadata: { ...metadata, baseUrl: ROTATED_BASE_URL },
        }),
      HttpStatus.Conflict,
      "credential.metadata.base_url_fixed",
    );
    fails(
      () =>
        f.updateMetadata("openai", {
          expectedRevision: FIRST_REVISION,
          metadata,
        }),
      HttpStatus.Conflict,
      REVISION_CONFLICT_CODE,
    );
    fails(
      () =>
        f.updateMetadata("missing", {
          expectedRevision: FIRST_REVISION,
          metadata,
        }),
      HttpStatus.NotFound,
      "credential.credential.not_found",
    );
    fails(
      () =>
        f.updateMetadata("openai", {
          expectedRevision: NEXT_REVISION,
          metadata: {},
        }),
      HttpStatus.BadRequest,
      "credential.input.invalid",
    );
    assert.equal(f.logs.at(-1)?.credentialId, row.id);
    assert.equal(f.logs.at(-1)?.humanIdentity, HUMAN_ACCOUNT_ID);
    assert.ok(!JSON.stringify(f.logs).includes(secretValue));
  } finally {
    f.store.close();
  }
});

test("two metadata edits with the same expected revision reject the second", () => {
  const f = fixture();
  try {
    f.create(inputs[0]);
    noSecret(
      f.updateMetadata("github", {
        expectedRevision: FIRST_REVISION,
        metadata: null,
      }),
    );
    fails(
      () =>
        f.updateMetadata("github", {
          expectedRevision: FIRST_REVISION,
          metadata: null,
        }),
      HttpStatus.Conflict,
      REVISION_CONFLICT_CODE,
    );
  } finally {
    f.store.close();
  }
});

test("revoke ends only an older live revision", () => {
  const f = fixture();
  try {
    f.create(inputs[0]);
    f.rotate("github", { expectedRevision: FIRST_REVISION, secret: apiSecret });
    fails(
      () => f.revoke("github", NEXT_REVISION),
      HttpStatus.Conflict,
      "credential.revision.newest_live",
    );
    const answer = f.revoke("github", FIRST_REVISION) as {
      revisions: { revision: number; endedAt: number | null }[];
    };
    assert.equal(answer.revisions[0]!.endedAt, null);
    assert.equal(answer.revisions[1]!.revision, FIRST_REVISION);
    assert.ok(answer.revisions[1]!.endedAt !== null);
    noSecret(answer);
    fails(
      () => f.revoke("github", FIRST_REVISION),
      HttpStatus.Conflict,
      "credential.revision.ended",
    );
    fails(
      () => f.revoke("github", THIRD_REVISION),
      HttpStatus.NotFound,
      "credential.revision.not_found",
    );
  } finally {
    f.store.close();
  }
});

test("custody suitability checks the newest live revision and platform", () => {
  const f = fixture();
  try {
    const suitability: CustodySuitabilityFn = f.component.custodySuitability;
    f.create(inputs[0]);
    f.store.transaction((tx) =>
      suitability(tx, { credential: "github", platform: Platform.GitHub }),
    );
    fails(
      () =>
        f.store.transaction((tx) =>
          suitability(tx, { credential: "missing", platform: Platform.GitHub }),
        ),
      HttpStatus.NotFound,
      CREDENTIAL_NOT_FOUND_CODE,
    );
    fails(
      () =>
        f.store.transaction((tx) =>
          suitability(tx, { credential: "github", platform: Platform.S3 }),
        ),
      HttpStatus.BadRequest,
      PLATFORM_MISMATCH_CODE,
    );
    f.rotate("github", { expectedRevision: FIRST_REVISION, secret: apiSecret });
    f.revoke("github", FIRST_REVISION);
    f.store.transaction((tx) =>
      suitability(tx, { credential: "github", platform: Platform.GitHub }),
    );
  } finally {
    f.store.close();
  }
});

test("credential metadata returns only nonsecret fields from the newest live revision", () => {
  const f = fixture();
  try {
    const metadata: CredentialMetadataFn = f.component.credentialMetadata;
    f.create(inputs[2]);
    f.create(inputs[0]);
    const openai = f.store.transaction((tx) => metadata(tx, "openai"));
    assert.deepEqual(openai?.metadata, inputs[2]!.metadata);
    assert.deepEqual(Object.keys(openai!), [
      "id",
      "name",
      "platform",
      "metadata",
    ]);
    assert.equal(openai?.name, inputs[2]!.name);
    assert.equal(openai?.platform, Platform.OpenAICompatible);
    noSecret(openai);
    const github = f.store.transaction((tx) => metadata(tx, "github"));
    assert.equal(github?.metadata, null);
    assert.deepEqual(Object.keys(github!), [
      "id",
      "name",
      "platform",
      "metadata",
    ]);
    assert.equal(
      f.store.transaction((tx) => metadata(tx, "missing")),
      null,
    );
    const rotated = f.rotate("openai", {
      expectedRevision: FIRST_REVISION,
      secret: apiSecret,
      metadata: { baseUrl: ROTATED_BASE_URL, models: [] },
    }) as { revisions: { id: string }[] };
    const newest = f.store.transaction((tx) => metadata(tx, "openai"));
    assert.equal(newest?.id, rotated.revisions[0]!.id);
    assert.deepEqual(newest?.metadata, {
      baseUrl: ROTATED_BASE_URL,
      models: [],
    });
    f.revoke("openai", FIRST_REVISION);
    assert.equal(
      f.store.transaction((tx) => metadata(tx, "openai"))?.id,
      rotated.revisions[0]!.id,
    );
  } finally {
    f.store.close();
  }
});

for (const mode of Object.values(RemovalMode)) {
  test(`${mode} refuses dependent model removal and permits unused model removal`, () => {
    const calls: {
      tx: Transaction;
      credentialName: string;
      modelId: string;
    }[] = [];
    let dependents = [{ agentName: DEPENDENT_AGENT }];
    const f = fixture({
      enablementsDependentOnModel: (tx, credentialName, modelId) => {
        calls.push({ tx, credentialName, modelId });
        return dependents;
      },
    });
    try {
      f.create(inputs[2]);
      const baseUrl = (inputs[2]!.metadata as { baseUrl: string }).baseUrl;
      const existing = {
        baseUrl,
        models: [{ id: REMOVED_MODEL }, { id: KEPT_MODEL }],
      };
      f.updateMetadata("openai", {
        expectedRevision: FIRST_REVISION,
        metadata: existing,
      });
      const next = { baseUrl, models: [{ id: KEPT_MODEL }] };
      const change = () =>
        mode === RemovalMode.Rotation
          ? f.rotate("openai", {
              expectedRevision: NEXT_REVISION,
              secret: apiSecret,
              metadata: next,
            })
          : f.updateMetadata("openai", {
              expectedRevision: NEXT_REVISION,
              metadata: next,
            });
      assert.throws(change, (error) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.status, HttpStatus.Conflict);
        assert.equal(error.code, MODEL_IN_USE_CODE);
        assert.deepEqual(error.details, {
          models: [{ model: REMOVED_MODEL, agents: [DEPENDENT_AGENT] }],
        });
        return true;
      });
      assert.strictEqual(calls[0]!.tx, f.lastTransaction());
      assert.equal(
        (f.get("openai") as { revisions: unknown[] }).revisions.length,
        NEXT_REVISION,
      );
      assert.equal(calls.length, FIRST_REVISION);
      assert.deepEqual(
        calls.map(({ credentialName, modelId }) => ({
          credentialName,
          modelId,
        })),
        [{ credentialName: "openai", modelId: REMOVED_MODEL }],
      );
      dependents = [];
      const result = change() as { revisions: { revision: number }[] };
      assert.equal(result.revisions.length, THIRD_REVISION);
      assert.equal(result.revisions[0]!.revision, THIRD_REVISION);
      assert.equal(calls.length, NEXT_REVISION);
      assert.deepEqual(
        calls.map(({ credentialName, modelId }) => ({
          credentialName,
          modelId,
        })),
        [
          { credentialName: "openai", modelId: REMOVED_MODEL },
          { credentialName: "openai", modelId: REMOVED_MODEL },
        ],
      );
      assert.strictEqual(calls[1]!.tx, f.lastTransaction());
    } finally {
      f.store.close();
    }
  });
}

test("credentialDependents returns both injected collaborations' results", () => {
  const agentProviders = [{ agentName: "agent", providerName: "provider" }];
  const bindings = [{ bindingId: "binding", projectId: "project" }];
  const calls: { tx: Transaction; name: string }[] = [];
  const f = fixture({
    agentProvidersDependentOn: (tx, name) => {
      calls.push({ tx, name });
      return agentProviders;
    },
    bindingsNaming: (tx, name) => {
      calls.push({ tx, name });
      return bindings;
    },
  });
  try {
    f.store.transaction((tx) => {
      assert.deepEqual(f.component.credentialDependents(tx, "openai"), {
        agentProviders,
        bindings,
      });
      assert.deepEqual(calls, [
        { tx, name: "openai" },
        { tx, name: "openai" },
      ]);
    });
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
      agentProvidersDependentOn: () => [],
      bindingsNaming: () => [],
      enablementsDependentOnModel: () => [],
    });
    const context = new CancellationContext();
    const running = other.run(context);
    context.cancel();
    assert.equal(await running, context.err());
  } finally {
    f.store.close();
  }
});
