import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { MASTER_KEY_BYTES } from "../config/global.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdempotencyKey } from "../kernel/identity.ts";
import {
  type Operation,
  OperationRegistry,
  StoreName,
} from "../kernel/operation.ts";
import { Store } from "../kernel/store.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";
import {
  HOST_NAME_MAX_LENGTH,
  repositoryOperations,
} from "../repository/contract.ts";
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

test("the host key scan host passes at its bound and one more character answers 400", async (t) => {
  await assertBound(
    t,
    repositoryOperations.host_key_scan,
    HOST_NAME_MAX_LENGTH,
    (length) => bodyInput({ host: "x".repeat(length) }),
  );
});
