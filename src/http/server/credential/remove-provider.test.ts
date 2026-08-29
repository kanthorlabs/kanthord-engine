import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { createMigratedStorage } from "../../../../test/helpers/database.ts";
import { createMockIdGenerator } from "../../../../test/helpers/ids.ts";
import { bootstrapActorId } from "../../../domain/actor.ts";
import { SqliteEventLog } from "../../../services/event/sqlite.ts";
import type { RemoveProviderInput } from "../../../commands/provider/remove-provider.ts";
import type { ProviderRemovalBlocker } from "../../../commands/provider/remove-provider.ts";
import {
  RemoveProviderError,
  removeProvider,
} from "../../../commands/provider/remove-provider.ts";
import { removeProviderHandler } from "./remove-provider.ts";
import { providerRemoveResponse } from "../../contract/credential.ts";

const providerId = "provider_01HZY8QF3M4N5P6R7S8T9V0W1X";

const blockers: readonly ProviderRemovalBlocker[] = [
  { kind: "default-chain" },
  { kind: "project-binding", projectId: "project_p" },
  { kind: "repository", repositoryId: "repository_chain" },
  { kind: "attempt", attemptId: "attempt_chain" },
];

describe("src/http/server/credential/remove-provider.test", () => {
  it("DELETE /v1/provider/<id> answers 200 with the removed id and passes the parsed id and the resolved actor", async () => {
    let called: RemoveProviderInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.remove": removeProviderHandler({
          removeProvider: (input) => {
            called = input;
            return { id: providerId };
          },
        }),
      },
    });
    const response = await app.del(`/v1/provider/${providerId}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { id: providerId });
    const parsed = providerRemoveResponse.parse(response.body);
    assert.deepEqual(Object.keys(parsed).sort(), ["id"]);
    assert.throws(() =>
      providerRemoveResponse.parse({ ...response.body, credential: "secret" }),
    );
    assert.deepEqual(called, {
      id: providerId,
      actor: bootstrapActorId,
      force: false,
    });
  });

  it("force=true passes force true to the command", async () => {
    let called: RemoveProviderInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.remove": removeProviderHandler({
          removeProvider: (input) => {
            called = input;
            return { id: providerId };
          },
        }),
      },
    });

    const response = await app.del(`/v1/provider/${providerId}?force=true`);

    assert.equal(response.status, 200);
    assert.deepEqual(called, {
      id: providerId,
      actor: bootstrapActorId,
      force: true,
    });
  });

  it("force=false passes force false to the command", async () => {
    let called: RemoveProviderInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.remove": removeProviderHandler({
          removeProvider: (input) => {
            called = input;
            return { id: providerId };
          },
        }),
      },
    });

    const response = await app.del(`/v1/provider/${providerId}?force=false`);
    const absentResponse = await app.del(`/v1/provider/${providerId}`);

    assert.equal(response.status, 200);
    assert.equal(absentResponse.status, 200);
    assert.deepEqual(response.body, absentResponse.body);
    assert.deepEqual(called, {
      id: providerId,
      actor: bootstrapActorId,
      force: false,
    });
  });

  it("an absent force parameter passes force false to the command", async () => {
    let called: RemoveProviderInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.remove": removeProviderHandler({
          removeProvider: (input) => {
            called = input;
            return { id: providerId };
          },
        }),
      },
    });

    const response = await app.del(`/v1/provider/${providerId}`);

    assert.equal(response.status, 200);
    assert.deepEqual(called, {
      id: providerId,
      actor: bootstrapActorId,
      force: false,
    });
  });

  it("force=1 answers 400 invalid-request without calling the command", async () => {
    let called: RemoveProviderInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.remove": removeProviderHandler({
          removeProvider: (input) => {
            called = input;
            return { id: providerId };
          },
        }),
      },
    });

    const response = await app.del(`/v1/provider/${providerId}?force=1`);

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(called, undefined);
  });

  it("force=yes answers 400 invalid-request without calling the command", async () => {
    let called: RemoveProviderInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.remove": removeProviderHandler({
          removeProvider: (input) => {
            called = input;
            return { id: providerId };
          },
        }),
      },
    });

    const response = await app.del(`/v1/provider/${providerId}?force=yes`);

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(called, undefined);
  });

  it("force=TRUE answers 400 invalid-request without calling the command", async () => {
    let called: RemoveProviderInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.remove": removeProviderHandler({
          removeProvider: (input) => {
            called = input;
            return { id: providerId };
          },
        }),
      },
    });

    const response = await app.del(`/v1/provider/${providerId}?force=TRUE`);

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(called, undefined);
  });

  it("an empty force value answers 400 invalid-request without calling the command", async () => {
    let called: RemoveProviderInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.remove": removeProviderHandler({
          removeProvider: (input) => {
            called = input;
            return { id: providerId };
          },
        }),
      },
    });

    const response = await app.del(`/v1/provider/${providerId}?force=`);

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(called, undefined);
  });

  it("invalid force values leave the persisted provider row untouched", async (t) => {
    for (const value of ["", "1", "yes", "TRUE"] as const) {
      const temporary = createMigratedStorage();
      t.after(() => temporary.dispose());
      temporary.storage.transact((transaction) => {
        transaction.run(
          "INSERT INTO provider (id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            providerId,
            "github-bot",
            "git",
            null,
            Buffer.from("ciphertext"),
            Buffer.alloc(12),
            Buffer.alloc(16),
            1,
            1,
          ],
        );
      });
      const app = await createTestApp({
        handlers: {
          "provider.remove": removeProviderHandler({
            removeProvider: (input) =>
              removeProvider(
                {
                  storage: temporary.storage,
                  events: new SqliteEventLog({
                    storage: temporary.storage,
                    ids: createMockIdGenerator({ ulids: [] }),
                  }),
                },
                input,
              ),
          }),
        },
      });

      const response = await app.del(
        `/v1/provider/${providerId}?force=${value}`,
      );
      assert.equal(response.status, 400, value);
      assert.equal(response.body.error.code, "invalid-request", value);
      const persisted = temporary.storage.transact((transaction) =>
        transaction.get("SELECT id FROM provider WHERE id = ?", [providerId]),
      );
      assert.equal(
        (persisted as { id: string } | undefined)?.id,
        providerId,
        value,
      );
    }
  });

  it("two force values answer 400 invalid-request without calling the command", async () => {
    let called: RemoveProviderInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.remove": removeProviderHandler({
          removeProvider: (input) => {
            called = input;
            return { id: providerId };
          },
        }),
      },
    });

    const response = await app.del(
      `/v1/provider/${providerId}?force=true&force=false`,
    );

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(called, undefined);
  });

  it("an unknown id refusal answers 404 not-found with the refusal message", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.remove": removeProviderHandler({
          removeProvider: () => {
            throw new RemoveProviderError(
              "not-found",
              `no provider ${providerId}`,
            );
          },
        }),
      },
    });
    const response = await app.del(`/v1/provider/${providerId}`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
    assert.equal(response.body.error.message, `no provider ${providerId}`);
  });

  it("a binding-in-use refusal answers 409 with the exact blocker array", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.remove": removeProviderHandler({
          removeProvider: () => {
            throw new RemoveProviderError(
              "binding-in-use",
              `provider ${providerId} is still in use`,
              blockers,
            );
          },
        }),
      },
    });
    const response = await app.del(`/v1/provider/${providerId}`);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "binding-in-use");
    assert.deepEqual(response.body.error.details.blockers, blockers);
  });
});
