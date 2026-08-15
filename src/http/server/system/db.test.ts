import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { dbHandler } from "./db.ts";
import type { ReadMigrationStatusResult } from "../../../queries/system/read-migration-status.ts";
import { findOperation } from "../../contract/registry.ts";
import { systemDbResponse } from "../../contract/system.ts";
import type { HandlerContext } from "../app.ts";
import {
  createTestApp,
  BOOTSTRAP_ACTOR_FIXTURE,
} from "../../../../test/helpers/app.ts";

const twoLines: ReadMigrationStatusResult = {
  migrations: [
    {
      version: 1,
      name: "0001-core-entities",
      applied: true,
      appliedAt: 1700000000,
    },
    {
      version: 2,
      name: "0002-graph-and-plan",
      applied: false,
      appliedAt: null,
    },
  ],
};

describe("src/http/server/system/db.test", () => {
  it("a clean request answers 200 with the query result", async () => {
    const app = await createTestApp({
      handlers: {
        "system.db": dbHandler({
          readMigrationStatus: () => twoLines,
        }),
      },
    });
    const response = await app.get("/v1/db/status");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, twoLines);
    assert.equal(systemDbResponse.safeParse(response.body).success, true);
  });

  it("a request without a token answers 401", async () => {
    const app = await createTestApp({
      handlers: {
        "system.db": dbHandler({
          readMigrationStatus: () => twoLines,
        }),
      },
    });
    const response = await app.raw
      .get("/v1/db/status")
      .set("Host", "kanthord.test");

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "unauthenticated");
  });

  it("the mock query is called once per request and never on a refusal", async () => {
    let calls = 0;
    const app = await createTestApp({
      handlers: {
        "system.db": dbHandler({
          readMigrationStatus: () => {
            calls += 1;
            return twoLines;
          },
        }),
      },
    });

    const clean = await app.get("/v1/db/status");
    assert.equal(clean.status, 200);
    assert.equal(calls, 1);

    const noToken = await app.raw
      .get("/v1/db/status")
      .set("Host", "kanthord.test");
    assert.equal(noToken.status, 401);

    assert.equal(calls, 1);
  });

  it("binding system.db does not bind system.status", async () => {
    const app = await createTestApp({
      handlers: {
        "system.db": dbHandler({
          readMigrationStatus: () => twoLines,
        }),
      },
    });
    const response = await app.get("/v1/status");

    assert.equal(response.status, 501);
    assert.equal(response.body.error.code, "not-implemented");
  });

  it("the handler formats the query result directly", () => {
    const handler = dbHandler({ readMigrationStatus: () => twoLines });
    const context: HandlerContext = {
      operation: findOperation("system.db")!,
      parameters: {},
      query: {},
      headers: {},
      body: undefined,
      actor: BOOTSTRAP_ACTOR_FIXTURE,
    };

    assert.deepEqual(handler(context), { status: 200, body: twoLines });
  });
});
