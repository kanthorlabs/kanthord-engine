import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "pino";
import { z } from "zod";
import { CancellationContext } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { HealthStatus } from "../kernel/service.ts";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import {
  CUSTODY_SERVICE_NAME,
  SecretShape,
  type CredentialMetadataFn,
  type CredentialPlatform,
  type CredentialPlatformSet,
  type CustodySuitabilityFn,
  type AgentProvidersDependentOnFn,
  type BindingsNamingFn,
  type InboundsNamingFn,
  type CredentialAnswer,
} from "./contract.ts";
import { decrypt } from "./envelope.ts";
import { custodyMigrations } from "./migrations.ts";
import { CustodyComponent, type Dependencies } from "./service.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { FacilityError } from "./facility.ts";
import { EXECUTION_CREDENTIAL_MAX_BYTES } from "./contract.ts";

const TestPlatform = {
  Key: "key-platform",
  OtherKey: "other-key-platform",
  Metadata: "metadata-platform",
  OAuth: "oauth-platform",
  AccessKey: "access-key-platform",
} as const;
const FOREIGN_PLATFORM = "foreign-platform";
const NO_CAPABILITY = "none";

function testPlatform(
  secretShape: SecretShape,
  metadataSchema: z.ZodObject | null = null,
): CredentialPlatform {
  return {
    secret_shape: secretShape,
    login_modes: [],
    metadata_schema: metadataSchema,
    capability: NO_CAPABILITY,
    probe: null,
  };
}

const TEST_SET: CredentialPlatformSet = {
  platforms: {
    [TestPlatform.Key]: testPlatform(SecretShape.ApiKey),
    [TestPlatform.OtherKey]: testPlatform(SecretShape.ApiKey),
    [TestPlatform.Metadata]: testPlatform(
      SecretShape.ApiKey,
      z.strictObject({
        base_url: z.string(),
        models: z.array(z.strictObject({ id: z.string() })),
      }),
    ),
    [TestPlatform.OAuth]: testPlatform(SecretShape.OAuth),
    [TestPlatform.AccessKey]: testPlatform(
      SecretShape.S3AccessKey,
      z.strictObject({
        endpoint: z.url(),
        bucket: z.string().min(1),
        region: z.string().min(1),
      }),
    ),
  },
};
const FOREIGN_SET: CredentialPlatformSet = {
  platforms: { [FOREIGN_PLATFORM]: testPlatform(SecretShape.ApiKey) },
};

const FIRST_REVISION = 1;
const HUMAN_ACCOUNT_ID = "alice";
const NAME_CONFLICT_CODE = "credential.name.conflict";
const REVISION_CONFLICT_CODE = "credential.revision.conflict";
const CREDENTIAL_NOT_FOUND_CODE = "credential.credential.not_found";
const PLATFORM_MISMATCH_CODE = "credential.platform.mismatch";
const NEXT_REVISION = FIRST_REVISION + 1;
const ROTATED_BASE_URL = "https://other.example/v1";
const THIRD_REVISION = NEXT_REVISION + 1;
const key = Buffer.alloc(32, 7);
const secretValue = "private-credential-value";
const apiSecret = { key: secretValue };
function unexpectedCollaboration(): never {
  throw new Error("UNEXPECTED_COLLABORATION");
}

test("credential creation and rotation enforce the serialized budget before any write", (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  const overhead = Buffer.byteLength(
    canonicalJSON({ type: "api_key", key: "" }),
  );
  const maximum = {
    key: "x".repeat(EXECUTION_CREDENTIAL_MAX_BYTES - overhead),
  };
  const oversized = { key: maximum.key + "x" };
  fails(
    () => f.create({ ...inputs[0], secret: oversized }),
    HttpStatus.BadRequest,
    INVALID_INPUT_CODE,
  );
  assert.equal(credentialCount(f), NO_CREDENTIALS);
  const created = f.create({
    ...inputs[0],
    secret: maximum,
  }) as CredentialAnswer;
  const before = f.store.database.prepare("SELECT * FROM credential").all();
  fails(
    () =>
      f.rotate(created.name, {
        expected_revision: FIRST_REVISION,
        secret: oversized,
      }),
    HttpStatus.BadRequest,
    INVALID_INPUT_CODE,
  );
  assert.deepEqual(
    f.store.database.prepare("SELECT * FROM credential").all(),
    before,
  );
  const rotated = f.rotate(created.name, {
    expected_revision: FIRST_REVISION,
    secret: maximum,
  }) as CredentialAnswer;
  assert.equal(rotated.revisions[0]?.revision, NEXT_REVISION);
});

const unusedExecutionDependencies = {
  executions: {
    requireRunning: unexpectedCollaboration,
    pinCredential: unexpectedCollaboration,
    liveExecutionsPinning: () => [],
  },
  authorization: { authorizeModelInference: unexpectedCollaboration },
  clientSecret: () => Buffer.alloc(32, 9).toString("base64"),
};
const inputs = [
  {
    name: "github",
    platform: TestPlatform.Key,
    secret: apiSecret,
    metadata: null,
  },
  {
    name: "anthropic",
    platform: TestPlatform.OtherKey,
    secret: apiSecret,
    metadata: null,
  },
  {
    name: "openai",
    platform: TestPlatform.Metadata,
    secret: apiSecret,
    metadata: { base_url: "https://example.com/v1", models: [] },
  },
  {
    name: "storage",
    platform: TestPlatform.AccessKey,
    secret: { access_key_id: "id", secret_access_key: secretValue },
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
    inboundsNaming?: InboundsNamingFn;
    pins?: Map<string, string[]>;
    authorization?: Dependencies["authorization"];
    executions?: Dependencies["executions"];
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
    ...unusedExecutionDependencies,
    authorization:
      collaborations.authorization ?? unusedExecutionDependencies.authorization,
    executions: collaborations.executions ?? {
      requireRunning: unexpectedCollaboration,
      pinCredential: (_tx, executionId, credentialId) => {
        collaborations.pins?.set(credentialId, [executionId]);
      },
      liveExecutionsPinning: (_tx, credentialId) =>
        collaborations.pins?.get(credentialId) ?? [],
    },
    store,
    platforms: { ...TEST_SET.platforms, ...FOREIGN_SET.platforms },
    envelopeKey: key,
    logger,
    health,
    agentProvidersDependentOn:
      collaborations.agentProvidersDependentOn ?? (() => []),
    bindingsNaming: collaborations.bindingsNaming ?? (() => []),
    inboundsNaming: collaborations.inboundsNaming ?? (() => []),
  });
  let lastTransaction: Transaction | undefined;
  const commit = <T>(write: (tx: Transaction) => T): T =>
    store.transaction((tx) => {
      lastTransaction = tx;
      return write(tx);
    });
  const create = (body: unknown, set = TEST_SET) =>
    commit((tx) =>
      component.create(
        tx,
        set,
        body as Parameters<CustodyComponent["create"]>[2],
        HUMAN_ACCOUNT_ID,
      ),
    );
  const get = (name: string, set = TEST_SET) =>
    commit((tx) => component.get(tx, set, name));
  const list = (query: Record<string, unknown> = {}, set = TEST_SET) =>
    commit((tx) =>
      component.list(tx, set, query as Parameters<CustodyComponent["list"]>[2]),
    );
  const rotate = (name: string, body: unknown, set = TEST_SET) =>
    commit((tx) =>
      component.rotate(
        tx,
        set,
        name,
        body as Parameters<CustodyComponent["rotate"]>[3],
        HUMAN_ACCOUNT_ID,
      ),
    );
  const updateMetadata = (name: string, body: unknown, set = TEST_SET) =>
    commit((tx) =>
      component.updateMetadata(
        tx,
        set,
        name,
        body as Parameters<CustodyComponent["updateMetadata"]>[3],
        HUMAN_ACCOUNT_ID,
      ),
    );
  const revoke = (name: string, revision: number, set = TEST_SET) =>
    commit((tx) => component.revoke(tx, set, name, revision));
  const archive = (name: string, set = TEST_SET) =>
    commit((tx) => component.archive(tx, set, name));
  return {
    store,
    component,
    lastTransaction: () => lastTransaction,
    health,
    logs,
    create,
    get,
    list,
    rotate,
    updateMetadata,
    revoke,
    archive,
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
      () => f.create({ ...inputs[0], name: "platform" }),
      HttpStatus.BadRequest,
      "credential.input.invalid",
    );
    fails(
      () => f.create({ ...inputs[0], name: "check" }),
      HttpStatus.BadRequest,
      "credential.input.invalid",
    );
    fails(
      () => f.create({ ...inputs[0], platform: TestPlatform.OAuth }),
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
    const filtered = f.list({ platform: TestPlatform.AccessKey }) as {
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
      }) as { items: { name: string }[]; next_cursor: string | null };
      noSecret(page);
      names.push(...page.items.map((item) => item.name));
      cursor = page.next_cursor;
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

test("rotate copies or replaces metadata and guards revisions", () => {
  const f = fixture();
  try {
    f.create(inputs[3]);
    const copied = f.rotate("storage", {
      expected_revision: FIRST_REVISION,
      secret: inputs[3]!.secret,
    }) as { revisions: { id: string; revision: number; metadata: unknown }[] };
    assert.deepEqual(copied.revisions[0]!.metadata, inputs[3]!.metadata);
    assert.equal(copied.revisions[0]!.revision, NEXT_REVISION);
    noSecret(copied);
    const replacement = { ...inputs[3]!.metadata, bucket: "other" };
    const replaced = f.rotate("storage", {
      expected_revision: NEXT_REVISION,
      secret: inputs[3]!.secret,
      metadata: replacement,
    }) as { revisions: { id: string; revision: number; metadata: unknown }[] };
    assert.deepEqual(replaced.revisions[0]!.metadata, replacement);
    assert.equal(replaced.revisions[0]!.revision, THIRD_REVISION);
    noSecret(replaced);
    assert.throws(
      () =>
        f.rotate("storage", {
          expected_revision: FIRST_REVISION,
          secret: apiSecret,
        }),
      (error) =>
        error instanceof OperationError &&
        error.status === HttpStatus.Conflict &&
        error.code === REVISION_CONFLICT_CODE &&
        (error.details as { revision: number }).revision === THIRD_REVISION,
    );
    const changed = replaced;
    fails(
      () =>
        f.rotate("missing", {
          expected_revision: FIRST_REVISION,
          secret: apiSecret,
        }),
      HttpStatus.NotFound,
      "credential.credential.not_found",
    );
    fails(
      () =>
        f.rotate("storage", { expected_revision: THIRD_REVISION, secret: {} }),
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
        expected_revision: FIRST_REVISION,
        secret: apiSecret,
      }),
    );
    fails(
      () =>
        f.rotate("github", {
          expected_revision: FIRST_REVISION,
          secret: apiSecret,
        }),
      HttpStatus.Conflict,
      REVISION_CONFLICT_CODE,
    );
  } finally {
    f.store.close();
  }
});

test("metadata edits re-encrypt under new identity and enforce revision", () => {
  const f = fixture();
  try {
    f.create(inputs[2]);
    const metadata = { ...inputs[2]!.metadata, models: [{ id: "added" }] };
    const answer = f.updateMetadata("openai", {
      expected_revision: FIRST_REVISION,
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
      decrypt(key, row.id, TestPlatform.Metadata, row.nonce, row.ciphertext),
      apiSecret,
    );
    noSecret(answer);
    fails(
      () =>
        f.updateMetadata("openai", {
          expected_revision: FIRST_REVISION,
          metadata,
        }),
      HttpStatus.Conflict,
      REVISION_CONFLICT_CODE,
    );
    fails(
      () =>
        f.updateMetadata("missing", {
          expected_revision: FIRST_REVISION,
          metadata,
        }),
      HttpStatus.NotFound,
      "credential.credential.not_found",
    );
    fails(
      () =>
        f.updateMetadata("openai", {
          expected_revision: NEXT_REVISION,
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
        expected_revision: FIRST_REVISION,
        metadata: null,
      }),
    );
    fails(
      () =>
        f.updateMetadata("github", {
          expected_revision: FIRST_REVISION,
          metadata: null,
        }),
      HttpStatus.Conflict,
      REVISION_CONFLICT_CODE,
    );
  } finally {
    f.store.close();
  }
});

test("rotation drains unpinned revisions while reads drain released pins", () => {
  const pins = new Map<string, string[]>();
  const f = fixture({ pins });
  try {
    const created = f.create(inputs[0]) as CredentialAnswer;
    const first = created.revisions[0]!.id;
    pins.set(first, ["live-execution"]);
    const rotated = f.rotate("github", {
      expected_revision: FIRST_REVISION,
      secret: apiSecret,
    }) as CredentialAnswer;
    assert(rotated.revisions.every((row) => row.ended_at === null));
    pins.clear();
    const read = f.get("github") as CredentialAnswer;
    assert.notEqual(read.revisions[1]!.ended_at, null);
    assert.equal(read.revisions[0]!.ended_at, null);
    const again = f.rotate("github", {
      expected_revision: NEXT_REVISION,
      secret: apiSecret,
    }) as CredentialAnswer;
    assert.notEqual(again.revisions[1]!.ended_at, null);
    assert.equal(again.revisions[0]!.ended_at, null);
    fails(
      () => f.revoke("github", NEXT_REVISION),
      HttpStatus.Conflict,
      "credential.revision.ended",
    );
  } finally {
    f.store.close();
  }
});

test("list drains every returned name and revoke drains other unpinned revisions", () => {
  const pins = new Map<string, string[]>();
  const f = fixture({ pins });
  try {
    for (const input of inputs.slice(0, 2)) {
      const created = f.create(input) as CredentialAnswer;
      pins.set(created.revisions[0]!.id, ["live-execution"]);
      f.rotate(input.name, {
        expected_revision: FIRST_REVISION,
        secret: apiSecret,
      });
    }
    pins.clear();
    const page = f.list() as { items: CredentialAnswer[] };
    for (const item of page.items) {
      assert.notEqual(item.revisions[1]!.ended_at, null);
      assert.equal(item.revisions[0]!.ended_at, null);
    }
    const current = f.get("github") as CredentialAnswer;
    pins.set(current.revisions[0]!.id, ["live-execution"]);
    const third = f.rotate("github", {
      expected_revision: NEXT_REVISION,
      secret: apiSecret,
    }) as CredentialAnswer;
    pins.set(third.revisions[0]!.id, ["live-execution"]);
    f.rotate("github", {
      expected_revision: THIRD_REVISION,
      secret: apiSecret,
    });
    pins.clear();
    const revoked = f.revoke("github", THIRD_REVISION) as CredentialAnswer;
    assert.equal(revoked.revisions[0]!.ended_at, null);
    assert(revoked.revisions.slice(1).every((row) => row.ended_at !== null));
  } finally {
    f.store.close();
  }
});

test("pinned metadata retains a rotated revision without creating a pin and refuses revocation", () => {
  const noPins = 0;
  const credentials: string[] = [];
  const execution = {
    executionId: "execution-one",
    runtimeIdentity: createIdentity("worker_instance"),
  };
  const f = fixture({
    executions: {
      requireRunning: (tx, executionId, runtimeIdentity) => {
        assert.ok(tx.database.isTransaction);
        assert.equal(executionId, execution.executionId);
        assert.equal(runtimeIdentity, execution.runtimeIdentity);
        return {
          execution_id: execution.executionId,
          runtime_identity: execution.runtimeIdentity,
          project_id: createIdentity("project"),
          worker_binding_id: "binding-one",
          resource_identity: "worker:kanthord:general",
          credentials,
        };
      },
      pinCredential: unexpectedCollaboration,
      liveExecutionsPinning: (_tx, id) =>
        credentials.includes(id) ? [execution.executionId] : [],
    },
  });
  const metadata = () =>
    f.store.transaction((tx) =>
      f.component.pinnedCredentialMetadata(tx, execution, "github", Date.now()),
    );
  try {
    const created = f.create(inputs[0]) as CredentialAnswer;
    assert.equal(metadata(), null);
    assert.equal(credentials.length, noPins);
    credentials.push(created.revisions[0]!.id);
    f.rotate("github", {
      expected_revision: FIRST_REVISION,
      secret: apiSecret,
    });
    assert.deepEqual(metadata(), {
      id: created.revisions[0]!.id,
      name: "github",
      platform: TestPlatform.Key,
      metadata: null,
    });
    assert.deepEqual(credentials, [created.revisions[0]!.id]);
    f.revoke("github", FIRST_REVISION);
    fails(metadata, HttpStatus.Conflict, "credential.revision.revoked");
    assert.deepEqual(credentials, [created.revisions[0]!.id]);
  } finally {
    f.store.close();
  }
});

test("protected release pins once, keeps rotation overlap and refuses revoked or unauthorized material", () => {
  const pins = new Map<string, string[]>();
  const credentials: string[] = [];
  const execution = {
    execution_id: "execution-one",
    project_id: createIdentity("project"),
    worker_binding_id: "binding-one",
    resource_identity: "worker:kanthord:general",
    runtime_identity: createIdentity("worker_instance"),
    credentials,
  };
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      projectId: execution.project_id,
      resourceIdentity: execution.resource_identity,
      name: "machine",
      issuedAt: 0,
    },
    "jti",
    execution.runtime_identity,
  );
  let platform: string = TestPlatform.Key;
  let refused = false;
  const f = fixture({
    pins,
    authorization: {
      authorizeModelInference: () => {
        if (refused) throw new Error("authorization refused");
        return {
          credential: "github",
          platform,
          provider_id: platform,
          agent_provider: "default",
        };
      },
    },
    executions: {
      requireRunning: unexpectedCollaboration,
      pinCredential: (_tx, executionId, credentialId) => {
        credentials.push(credentialId);
        pins.set(credentialId, [executionId]);
      },
      liveExecutionsPinning: (_tx, credentialId) =>
        pins.get(credentialId) ?? [],
    },
  });
  const release = () =>
    f.store.transaction((tx) => {
      const grant = f.component.authorize(tx, identity, execution);
      const material = f.component.release(tx, grant, Date.now());
      try {
        assert.deepEqual(material.value(), apiSecret);
        assert.throws(
          () => f.component.release(tx, grant, Date.now()),
          FacilityError,
        );
        return material.credential_id;
      } finally {
        material.drop();
      }
    });
  try {
    const created = f.create(inputs[0]) as CredentialAnswer;
    assert.equal(release(), created.revisions[0]!.id);
    assert.deepEqual(credentials, [created.revisions[0]!.id]);
    f.rotate("github", {
      expected_revision: FIRST_REVISION,
      secret: apiSecret,
    });
    assert.equal(release(), created.revisions[0]!.id);
    assert.deepEqual(credentials, [created.revisions[0]!.id]);
    platform = TestPlatform.AccessKey;
    fails(release, HttpStatus.BadRequest, PLATFORM_MISMATCH_CODE);
    platform = TestPlatform.Key;
    refused = true;
    assert.throws(release, /authorization refused/);
    refused = false;
    f.revoke("github", FIRST_REVISION);
    fails(release, HttpStatus.Conflict, "credential.revision.revoked");
    credentials.length = 0;
    const latest = f.get("github") as CredentialAnswer;
    execution.execution_id = "execution-two";
    assert.equal(release(), latest.revisions[0]!.id);
    noSecret(f.logs);
  } finally {
    f.store.close();
  }
});

test("revoke ends only an older live revision", () => {
  const pins = new Map<string, string[]>();
  const f = fixture({ pins });
  try {
    const created = f.create(inputs[0]) as CredentialAnswer;
    pins.set(created.revisions[0]!.id, ["live-execution"]);
    f.rotate("github", {
      expected_revision: FIRST_REVISION,
      secret: apiSecret,
    });
    fails(
      () => f.revoke("github", NEXT_REVISION),
      HttpStatus.Conflict,
      "credential.revision.newest_live",
    );
    const answer = f.revoke("github", FIRST_REVISION) as {
      revisions: { revision: number; ended_at: number | null }[];
    };
    assert.equal(answer.revisions[0]!.ended_at, null);
    assert.equal(answer.revisions[1]!.revision, FIRST_REVISION);
    assert.ok(answer.revisions[1]!.ended_at !== null);
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
  const pins = new Map<string, string[]>();
  const f = fixture({ pins });
  try {
    const suitability: CustodySuitabilityFn = f.component.custodySuitability;
    const created = f.create(inputs[0]) as CredentialAnswer;
    pins.set(created.revisions[0]!.id, ["live-execution"]);
    f.store.transaction((tx) =>
      suitability(tx, { credential: "github", platform: TestPlatform.Key }),
    );
    fails(
      () =>
        f.store.transaction((tx) =>
          suitability(tx, {
            credential: "missing",
            platform: TestPlatform.Key,
          }),
        ),
      HttpStatus.NotFound,
      CREDENTIAL_NOT_FOUND_CODE,
    );
    fails(
      () =>
        f.store.transaction((tx) =>
          suitability(tx, {
            credential: "github",
            platform: TestPlatform.AccessKey,
          }),
        ),
      HttpStatus.BadRequest,
      PLATFORM_MISMATCH_CODE,
    );
    f.rotate("github", {
      expected_revision: FIRST_REVISION,
      secret: apiSecret,
    });
    f.revoke("github", FIRST_REVISION);
    f.store.transaction((tx) =>
      suitability(tx, { credential: "github", platform: TestPlatform.Key }),
    );
  } finally {
    f.store.close();
  }
});

test("credential metadata returns only nonsecret fields from the newest live revision", () => {
  const pins = new Map<string, string[]>();
  const f = fixture({ pins });
  try {
    const metadata: CredentialMetadataFn = f.component.credentialMetadata;
    const created = f.create(inputs[2]) as CredentialAnswer;
    pins.set(created.revisions[0]!.id, ["live-execution"]);
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
    assert.equal(openai?.platform, TestPlatform.Metadata);
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
      expected_revision: FIRST_REVISION,
      secret: apiSecret,
      metadata: { base_url: ROTATED_BASE_URL, models: [] },
    }) as { revisions: { id: string }[] };
    const newest = f.store.transaction((tx) => metadata(tx, "openai"));
    assert.equal(newest?.id, rotated.revisions[0]!.id);
    assert.deepEqual(newest?.metadata, {
      base_url: ROTATED_BASE_URL,
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

test("create refuses a platform outside the platform set of the caller", () => {
  const f = fixture();
  try {
    fails(
      () => f.create({ ...inputs[0], platform: FOREIGN_PLATFORM }),
      HttpStatus.BadRequest,
      "credential.platform.unsupported",
    );
    fails(
      () => f.create({ ...inputs[0], platform: TestPlatform.Key }, FOREIGN_SET),
      HttpStatus.BadRequest,
      "credential.platform.unsupported",
    );
    assert.equal(credentialCount(f), NO_CREDENTIALS);
  } finally {
    f.store.close();
  }
});

test("a name of another platform set answers not found on every read and write", () => {
  const f = fixture();
  try {
    f.create(inputs[0]);
    f.create(
      {
        name: "foreign",
        platform: FOREIGN_PLATFORM,
        secret: apiSecret,
        metadata: null,
      },
      FOREIGN_SET,
    );
    for (const call of [
      () => f.get("foreign"),
      () =>
        f.rotate("foreign", {
          expected_revision: FIRST_REVISION,
          secret: apiSecret,
        }),
      () =>
        f.updateMetadata("foreign", {
          expected_revision: FIRST_REVISION,
          metadata: null,
        }),
      () => f.revoke("foreign", FIRST_REVISION),
      () => f.archive("foreign"),
      () => f.get("github", FOREIGN_SET),
      () => f.archive("github", FOREIGN_SET),
    ])
      fails(call, HttpStatus.NotFound, CREDENTIAL_NOT_FOUND_CODE);
    const names = (value: unknown) =>
      (value as { items: CredentialAnswer[] }).items.map(({ name }) => name);
    assert.deepEqual(names(f.list({ include_archived: "true" })), ["github"]);
    assert.deepEqual(names(f.list({ platform: FOREIGN_PLATFORM })), []);
    assert.deepEqual(names(f.list({}, FOREIGN_SET)), ["foreign"]);
    assert.equal(
      (f.get("foreign", FOREIGN_SET) as CredentialAnswer).platform,
      FOREIGN_PLATFORM,
    );
  } finally {
    f.store.close();
  }
});

test("credentialDependents returns both injected collaborations' results", () => {
  const agentProviders = [{ agent_name: "agent", provider_name: "provider" }];
  const bindings = [{ binding_id: "binding", project_id: "project" }];
  const namings = [{ ...bindings[0]!, project_name: "alpha", name: "repo" }];
  const inbounds = [{ inbound_id: "inbound" }];
  const calls: { tx: Transaction; name: string }[] = [];
  const f = fixture({
    agentProvidersDependentOn: (tx, name) => {
      calls.push({ tx, name });
      return agentProviders;
    },
    bindingsNaming: (tx, name) => {
      calls.push({ tx, name });
      return namings;
    },
    inboundsNaming: (tx, name) => {
      calls.push({ tx, name });
      return inbounds;
    },
  });
  try {
    f.store.transaction((tx) => {
      assert.deepEqual(f.component.credentialDependents(tx, "openai"), {
        agent_providers: agentProviders,
        bindings,
        inbounds,
      });
      assert.deepEqual(calls, [
        { tx, name: "openai" },
        { tx, name: "openai" },
        { tx, name: "openai" },
      ]);
    });
  } finally {
    f.store.close();
  }
});

const IN_USE_CODE = "credential.credential.in_use";
const GITHUB_NAME = "github";
const CHECKS_OF_TWO_ARCHIVES = 6;

function archiveCall(f: ReturnType<typeof fixture>, name: string) {
  return () => f.archive(name);
}

function inUseDetails(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof OperationError);
    assert.equal(error.status, HttpStatus.Conflict);
    assert.equal(error.code, IN_USE_CODE);
    return error.details;
  }
  return assert.fail("archive must refuse");
}

const NO_DEPENDENTS = { agent_providers: [], bindings: [], inbounds: [] };
const AGENT_DEPENDENT = [{ agent_name: "agent", provider_name: "provider" }];
const BINDING_DEPENDENT = [{ binding_id: "binding", project_id: "project" }];
const BINDING_NAMING = [
  { ...BINDING_DEPENDENT[0]!, project_name: "alpha", name: "repo" },
];
const INBOUND_DEPENDENT = [{ inbound_id: "inbound" }];

for (const [kind, collaboration, dependents] of [
  [
    "agent provider",
    { agentProvidersDependentOn: () => AGENT_DEPENDENT },
    { ...NO_DEPENDENTS, agent_providers: AGENT_DEPENDENT },
  ],
  [
    "binding",
    { bindingsNaming: () => BINDING_NAMING },
    { ...NO_DEPENDENTS, bindings: BINDING_DEPENDENT },
  ],
  [
    "inbound",
    { inboundsNaming: () => INBOUND_DEPENDENT },
    { ...NO_DEPENDENTS, inbounds: INBOUND_DEPENDENT },
  ],
] as const) {
  test(`archive refuses a ${kind} dependent with its details`, () => {
    const f = fixture(collaboration);
    try {
      f.create(inputs[0]);
      assert.deepEqual(inUseDetails(archiveCall(f, "github")), dependents);
      const read = f.get("github") as CredentialAnswer;
      assert(read.revisions.every((row) => row.ended_at === null));
    } finally {
      f.store.close();
    }
  });
}

test("archive ends every live revision and keeps every row", () => {
  const pins = new Map<string, string[]>();
  const f = fixture({ pins });
  try {
    const created = f.create(inputs[0]) as CredentialAnswer;
    pins.set(created.revisions[0]!.id, ["live-execution"]);
    f.rotate("github", {
      expected_revision: FIRST_REVISION,
      secret: apiSecret,
    });
    const archived = archiveCall(f, "github")() as CredentialAnswer;
    assert.equal(archived.name, GITHUB_NAME);
    assert.equal(archived.revisions.length, NEXT_REVISION);
    assert(archived.revisions.every((row) => row.ended_at !== null));
    const read = f.get("github") as CredentialAnswer;
    assert.equal(read.revisions.length, NEXT_REVISION);
    noSecret(archived);
  } finally {
    f.store.close();
  }
});

test("archive answers not found for an unknown name", () => {
  const f = fixture();
  try {
    fails(
      archiveCall(f, "missing"),
      HttpStatus.NotFound,
      "credential.credential.not_found",
    );
  } finally {
    f.store.close();
  }
});

const ARCHIVED_CODE = "credential.credential.archived";
const REVOKE_ENDED_CODE = "credential.revision.ended";
const EVERY_ARCHIVE_STEP = 3;
const PAGE_OF_ONE = 1;

function archivedFixture() {
  const f = fixture();
  f.create(inputs[0]);
  archiveCall(f, "github")();
  return f;
}

test("an archived name refuses rotate, update-metadata and a second archive", () => {
  const f = archivedFixture();
  try {
    fails(
      () =>
        f.rotate("github", {
          expected_revision: FIRST_REVISION,
          secret: apiSecret,
        }),
      HttpStatus.Conflict,
      ARCHIVED_CODE,
    );
    fails(
      () =>
        f.updateMetadata("github", {
          expected_revision: FIRST_REVISION,
          metadata: null,
        }),
      HttpStatus.Conflict,
      ARCHIVED_CODE,
    );
    fails(archiveCall(f, "github"), HttpStatus.Conflict, ARCHIVED_CODE);
    fails(
      () => f.revoke("github", FIRST_REVISION),
      HttpStatus.Conflict,
      REVOKE_ENDED_CODE,
    );
  } finally {
    f.store.close();
  }
});

test("an archived name stays taken", () => {
  const f = archivedFixture();
  try {
    fails(() => f.create(inputs[0]), HttpStatus.Conflict, NAME_CONFLICT_CODE);
  } finally {
    f.store.close();
  }
});

test("get answers an archived name unchanged", () => {
  const f = archivedFixture();
  try {
    const read = f.get("github") as CredentialAnswer;
    assert.equal(read.name, GITHUB_NAME);
    assert(read.revisions.every((row) => row.ended_at !== null));
  } finally {
    f.store.close();
  }
});

test("a rotation never archives a name", () => {
  const f = fixture();
  try {
    f.create(inputs[0]);
    for (let step = 0; step < EVERY_ARCHIVE_STEP; step += 1) {
      const read = f.get("github") as CredentialAnswer;
      const answer = f.rotate("github", {
        expected_revision: read.revisions[0]!.revision,
        secret: apiSecret,
      }) as CredentialAnswer;
      assert(answer.revisions.some((row) => row.ended_at === null));
      assert.equal(answer.revisions[0]!.ended_at, null);
    }
  } finally {
    f.store.close();
  }
});

test("list leaves out an archived name unless include_archived is true and pages correctly", () => {
  const f = fixture();
  try {
    for (const input of [inputs[0], inputs[1], inputs[2]]) f.create(input);
    archiveCall(f, "anthropic")();
    const names = (value: unknown) =>
      (value as { items: CredentialAnswer[] }).items.map(({ name }) => name);
    assert.deepEqual(names(f.list()), ["github", "openai"]);
    assert.deepEqual(names(f.list({ include_archived: "false" })), [
      "github",
      "openai",
    ]);
    assert.deepEqual(names(f.list({ include_archived: "true" })), [
      "anthropic",
      "github",
      "openai",
    ]);
    const first = f.list({ limit: PAGE_OF_ONE }) as {
      items: CredentialAnswer[];
      next_cursor: string | null;
    };
    assert.deepEqual(names(first), ["github"]);
    const second = f.list({
      limit: PAGE_OF_ONE,
      cursor: first.next_cursor,
    }) as { items: CredentialAnswer[]; next_cursor: string | null };
    assert.deepEqual(names(second), ["openai"]);
    assert.equal(second.next_cursor, null);
  } finally {
    f.store.close();
  }
});

test("archive checks every dependent in the transaction of the write", () => {
  const seen: Transaction[] = [];
  const dependents: { inbounds: { inbound_id: string }[] } = { inbounds: [] };
  const f = fixture({
    agentProvidersDependentOn: (tx) => {
      seen.push(tx);
      return [];
    },
    bindingsNaming: (tx) => {
      seen.push(tx);
      return [];
    },
    inboundsNaming: (tx) => {
      seen.push(tx);
      return dependents.inbounds;
    },
  });
  try {
    f.create(inputs[0]);
    dependents.inbounds = INBOUND_DEPENDENT;
    assert.deepEqual(inUseDetails(archiveCall(f, "github")), {
      ...NO_DEPENDENTS,
      inbounds: INBOUND_DEPENDENT,
    });
    dependents.inbounds = [];
    archiveCall(f, "github")();
    assert.equal(seen.length, CHECKS_OF_TWO_ARCHIVES);
    assert.strictEqual(seen[3], f.lastTransaction());
    assert.strictEqual(seen[4], f.lastTransaction());
    assert.strictEqual(seen[5], f.lastTransaction());
    assert.notStrictEqual(seen[0], seen[3]);
  } finally {
    f.store.close();
  }
});

const INVALID_INPUT_CODE = "credential.input.invalid";
const NO_CREDENTIALS = 0;

function credentialCount(f: ReturnType<typeof fixture>): number {
  return (
    f.store.database
      .prepare("SELECT COUNT(*) AS count FROM credential")
      .get() as { count: number }
  ).count;
}

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
      ...unusedExecutionDependencies,
      store: f.store,
      envelopeKey: key,
      logger: { info() {} } as unknown as Logger,
      agentProvidersDependentOn: () => [],
      bindingsNaming: () => [],
      inboundsNaming: () => [],
      platforms: TEST_SET.platforms,
    });
    const context = new CancellationContext();
    const running = other.run(context);
    context.cancel();
    assert.equal(await running, context.err());
  } finally {
    f.store.close();
  }
});

const CHECK_UNSUPPORTED_CODE = "credential.check.unsupported";
const UNSUPPORTED_PLATFORM_CODE = "credential.platform.unsupported";
const CHECK_CAPABILITY = "check capability";
const CHECK_DEADLINE_MS = 10000;
const DEADLINE_TOLERANCE_MS = 1000;
const ONE_CALL = 1;

test("check runs the probe of the platform on the parsed secret and metadata and stores nothing", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  const calls: {
    secret: unknown;
    metadata: unknown;
    deadline: number | null;
    context: CancellationContext;
  }[] = [];
  const set: CredentialPlatformSet = {
    platforms: {
      [TestPlatform.Metadata]: {
        ...TEST_SET.platforms[TestPlatform.Metadata]!,
        capability: CHECK_CAPABILITY,
        probe: async (secret, metadata, context) => {
          calls.push({
            secret,
            metadata,
            deadline: context.deadline(),
            context: context as CancellationContext,
          });
          return "unhealthy";
        },
      },
      [TestPlatform.OAuth]: {
        ...TEST_SET.platforms[TestPlatform.OAuth]!,
        probe: async () => "healthy",
      },
      [TestPlatform.Key]: TEST_SET.platforms[TestPlatform.Key]!,
    },
  };
  const body = {
    platform: TestPlatform.Metadata,
    secret: apiSecret,
    metadata: { base_url: "https://example.com/v1", models: [] },
  };
  const answer = await f.component.check(set, body, new CancellationContext());
  assert.deepEqual(answer, {
    status: "unhealthy",
    capability: CHECK_CAPABILITY,
  });
  assert.equal(calls.length, ONE_CALL);
  assert.deepEqual(calls[0]!.secret, apiSecret);
  assert.deepEqual(calls[0]!.metadata, body.metadata);
  const remaining = calls[0]!.deadline! - Date.now();
  assert.ok(remaining <= CHECK_DEADLINE_MS);
  assert.ok(remaining > CHECK_DEADLINE_MS - DEADLINE_TOLERANCE_MS);
  assert.ok(calls[0]!.context.err());
  assert.equal(credentialCount(f), NO_CREDENTIALS);
  noSecret(answer);
  for (const platform of [TestPlatform.OAuth, TestPlatform.Key])
    await assert.rejects(
      f.component.check(set, { ...body, platform }, new CancellationContext()),
      (error) =>
        error instanceof OperationError &&
        error.status === HttpStatus.BadRequest &&
        error.code === CHECK_UNSUPPORTED_CODE,
    );
  await assert.rejects(
    f.component.check(
      set,
      { ...body, platform: FOREIGN_PLATFORM },
      new CancellationContext(),
    ),
    (error) =>
      error instanceof OperationError &&
      error.status === HttpStatus.BadRequest &&
      error.code === UNSUPPORTED_PLATFORM_CODE,
  );
  for (const invalid of [
    { ...body, secret: { key: "" } },
    { ...body, secret: { access_key_id: "id", secret_access_key: "s" } },
    { ...body, metadata: null },
    { ...body, metadata: { base_url: "https://example.com/v1" } },
  ])
    await assert.rejects(
      f.component.check(set, invalid, new CancellationContext()),
      (error) =>
        error instanceof OperationError &&
        error.status === HttpStatus.BadRequest &&
        error.code === INVALID_INPUT_CODE,
    );
  assert.equal(calls.length, ONE_CALL);
  assert.equal(credentialCount(f), NO_CREDENTIALS);
});

test("check answers unknown when the probe throws", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  const set: CredentialPlatformSet = {
    platforms: {
      [TestPlatform.Key]: {
        ...TEST_SET.platforms[TestPlatform.Key]!,
        probe: async () => {
          throw new Error(secretValue);
        },
      },
    },
  };
  const answer = await f.component.check(
    set,
    { platform: TestPlatform.Key, secret: apiSecret, metadata: null },
    new CancellationContext(),
  );
  assert.deepEqual(answer, { status: "unknown", capability: NO_CAPABILITY });
});
