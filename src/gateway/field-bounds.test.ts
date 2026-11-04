import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { MASTER_KEY_BYTES } from "../config/global.ts";
import {
  CREDENTIAL_METADATA_MAX_BYTES,
  CREDENTIAL_NAME_MAX_LENGTH,
  credentialCheckBodySchema,
  credentialCreateSchema,
  credentialRotateBodySchema,
  credentialUpdateMetadataBodySchema,
} from "../custody/contract.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import { createIdempotencyKey, createIdentity } from "../kernel/identity.ts";
import {
  AccessPolicy,
  type Operation,
  OperationLifetime,
  OperationRegistry,
  StoreName,
} from "../kernel/operation.ts";
import { Store } from "../kernel/store.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";
import {
  COPY_REPORT_TEXT_MAX_LENGTH,
  llmOperations,
  LOGIN_REPORT_TEXT_MAX_LENGTH,
} from "../llm/contract.ts";
import {
  HOST_NAME_MAX_LENGTH,
  repositoryOperations,
} from "../repository/contract.ts";
import {
  WORKBENCH_MESSAGE_MAX_LENGTH,
  WORKBENCH_SESSION_PREFIX,
  workbenchOperations,
} from "../workbench/contract.ts";
import { generateHumanJWT } from "./auth/jwt.ts";
import { createInvocation, gatewayMigrations } from "./index.ts";

const AUTH_VERSION = 1;
const TOKEN_LIFETIME_SECONDS = 600;
const NEXT_UNIT = 1;
const HANDLER_REACHED = "test.handler.reached";
const REACHED = { status: HttpStatus.Conflict, code: HANDLER_REACHED };
const REFUSED = {
  status: HttpStatus.BadRequest,
  code: "gateway.request.validation_failed",
};
const QUOTE_BYTES = JSON.stringify("").length;

type Input = { params: unknown; query: unknown; body: unknown };

async function answerOf(t: TestContext, operation: Operation, input: Input) {
  const registry = new OperationRegistry();
  registry.register(operation, () => {
    throw new OperationError(
      HttpStatus.Conflict,
      HANDLER_REACHED,
      "The handler is reached.",
    );
  });
  const store = new Store(":memory:");
  stopAfter(t, () => store.close());
  store.migrate([{ service: "gateway", migrations: gatewayMigrations }]);
  registry.seal({ [StoreName.Operational]: store });
  const masterKey = randomBytes(MASTER_KEY_BYTES).toString("base64");
  const invocation = createInvocation({
    registry,
    stores: { [StoreName.Operational]: store },
    masterKey,
    authVersion: AUTH_VERSION,
  });
  stopAfter(t, () => invocation.stop());
  const { token } = await generateHumanJWT(
    masterKey,
    AUTH_VERSION,
    TOKEN_LIFETIME_SECONDS,
  );
  const response = await invocation.invoke(operation.id, input, {
    authorization: `Bearer ${token}`,
    idempotencyKey: createIdempotencyKey(),
  });
  return {
    status: response.status,
    code: (response.body as { error: { code: string } }).error.code,
  };
}

async function assertBound(
  t: TestContext,
  operation: Operation,
  bound: number,
  inputAt: (size: number) => Input,
) {
  assert.deepEqual(
    await answerOf(t, operation, inputAt(bound)),
    REACHED,
    operation.id,
  );
  assert.deepEqual(
    await answerOf(t, operation, inputAt(bound + NEXT_UNIT)),
    REFUSED,
    operation.id,
  );
}

function bodyInput(body: unknown, params: unknown = {}): Input {
  return { params, query: {}, body };
}

function credentialBodyOperation(body: z.ZodType): Operation {
  return {
    id: "test.credential.body",
    service: "test",
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    method: HttpMethod.Post,
    path: "/api/test/credential/body",
    access: AccessPolicy.Human,
    timeoutMs: 30000,
    mutation: true,
    body: true,
    input: z.strictObject({
      params: z.strictObject({}),
      query: z.strictObject({}),
      body,
    }),
    output: z.null(),
    status: HttpStatus.OK,
    description: "Parse one credential body.",
  };
}

function metadataOf(bytes: number): string {
  return "x".repeat(bytes - QUOTE_BYTES);
}

test("the metadata of each credential body passes at its bound and one more byte answers 400", async (t) => {
  for (const [schema, body] of [
    [credentialCreateSchema, { name: "bounded", platform: "p", secret: null }],
    [credentialCheckBodySchema, { platform: "p", secret: null }],
    [credentialRotateBodySchema, { expected_revision: 1, secret: null }],
    [credentialUpdateMetadataBodySchema, { expected_revision: 1 }],
  ] as const)
    await assertBound(
      t,
      credentialBodyOperation(schema),
      CREDENTIAL_METADATA_MAX_BYTES,
      (bytes) => bodyInput({ ...body, metadata: metadataOf(bytes) }),
    );
  await assertBound(
    t,
    llmOperations.create,
    CREDENTIAL_METADATA_MAX_BYTES,
    (bytes) =>
      bodyInput({
        name: "bounded",
        platform: "anthropic",
        metadata: metadataOf(bytes),
      }),
  );
  await assertBound(
    t,
    llmOperations.rotate,
    CREDENTIAL_METADATA_MAX_BYTES,
    (bytes) =>
      bodyInput(
        { expected_revision: 1, metadata: metadataOf(bytes) },
        { credential_name: "bounded" },
      ),
  );
});

test("the login code value passes at its bound and one more character answers 400", async (t) => {
  await assertBound(
    t,
    llmOperations.login_code,
    LOGIN_REPORT_TEXT_MAX_LENGTH,
    (length) =>
      bodyInput({ value: "x".repeat(length) }, { session_id: "session" }),
  );
});

test("each model check field passes at its bound and one more character answers 400", async (t) => {
  const bodyWith = (field: string, length: number) =>
    bodyInput({
      credential: "anthropic",
      model_identifier: "claude-sonnet-4-5",
      reasoning_effort: "off",
      [field]: "x".repeat(length),
    });
  await assertBound(
    t,
    llmOperations.model_check,
    CREDENTIAL_NAME_MAX_LENGTH,
    (length) => bodyWith("credential", length),
  );
  for (const field of ["model_identifier", "reasoning_effort"])
    await assertBound(
      t,
      llmOperations.model_check,
      COPY_REPORT_TEXT_MAX_LENGTH,
      (length) => bodyWith(field, length),
    );
});

test("the host key scan host passes at its bound and one more character answers 400", async (t) => {
  await assertBound(
    t,
    repositoryOperations.host_key_scan,
    HOST_NAME_MAX_LENGTH,
    (length) => bodyInput({ host: "x".repeat(length) }),
  );
});

test("each workbench configuration field passes at its bound and one more character answers 400", async (t) => {
  const params = { session_id: createIdentity(WORKBENCH_SESSION_PREFIX) };
  const configurationWith = (field: string, length: number) => ({
    agent_provider: "anthropic",
    model_identifier: "claude-sonnet-4-5",
    reasoning_effort: "off",
    [field]: "x".repeat(length),
  });
  for (const field of ["agent_provider", "model_identifier"]) {
    await assertBound(
      t,
      workbenchOperations["session.create"],
      COPY_REPORT_TEXT_MAX_LENGTH,
      (length) =>
        bodyInput({ ...configurationWith(field, length), agent_name: "swe@1" }),
    );
    await assertBound(
      t,
      workbenchOperations["session.configure"],
      COPY_REPORT_TEXT_MAX_LENGTH,
      (length) => bodyInput(configurationWith(field, length), params),
    );
  }
});

test("the workbench message text passes at its bound and one more character answers 400", async (t) => {
  await assertBound(
    t,
    workbenchOperations["session.message"],
    WORKBENCH_MESSAGE_MAX_LENGTH,
    (length) =>
      bodyInput(
        { text: "x".repeat(length) },
        { session_id: createIdentity(WORKBENCH_SESSION_PREFIX) },
      ),
  );
});
