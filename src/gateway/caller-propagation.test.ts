import assert from "node:assert/strict";
import { test } from "node:test";
import { directClient } from "./index.ts";
import { generateHumanJWT } from "./local.ts";
import { gatewayOperations } from "./contract.ts";
import { IdentityKind } from "../kernel/caller.ts";
import { OperationResultType } from "../kernel/operation.ts";
import { HttpStatus } from "../kernel/http.ts";
import { gatewayFixture } from "./test-support.ts";

const input = { params: {}, query: {}, body: null };
const usernames = ["first-human", "second-human"];

test("one direct client forwards each call's identity without retaining a previous caller", async (t) => {
  const fixture = await gatewayFixture(t);
  const client = directClient(gatewayOperations, fixture.gateway.invocation);
  for (const username of usernames) {
    const issued = await generateHumanJWT(
      fixture.config.masterKey,
      fixture.config.gateway.tokenLifetime,
      username,
    );
    const identity = await fixture.gateway.authentication.authenticate(
      `Bearer ${issued.token}`,
    );
    const result = await client.verify(input, { identity });
    assert.equal(result.type, OperationResultType.Completed);
    assert.ok(result.type === OperationResultType.Completed);
    assert.deepEqual(result.data, {
      kind: IdentityKind.Human,
      accountId: username,
      name: username,
    });
    for (const options of [{}, { identity: { ...identity } }]) {
      const refused = await client.verify(input, options);
      assert.equal(refused.type, OperationResultType.Failure);
      assert.ok(refused.type === OperationResultType.Failure);
      assert.equal(refused.status, HttpStatus.Unauthorized);
    }
  }
});
