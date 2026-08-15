import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import type { TestApp } from "../../../../test/helpers/app.ts";
import {
  createMigratedStorage,
  tableBytes,
} from "../../../../test/helpers/database.ts";
import { createMockClock } from "../../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../../test/helpers/ids.ts";
import { NodeCryptoSecret } from "../../../services/secret/node-crypto.ts";
import { SqliteEventLog } from "../../../services/event/sqlite.ts";
import { resolveActor } from "../../../queries/actor/resolve-actor.ts";
import { registerActor } from "../../../commands/actor/register-actor.ts";
import type { RegisterActorInput } from "../../../commands/actor/register-actor.ts";
import { revokeActor } from "../../../commands/actor/revoke-actor.ts";
import type { RevokeActorInput } from "../../../commands/actor/revoke-actor.ts";
import { rotateActorToken } from "../../../commands/actor/rotate-actor-token.ts";
import type { RotateActorTokenInput } from "../../../commands/actor/rotate-actor-token.ts";
import { listActors } from "../../../queries/actor/list-actor.ts";
import type { ListActorInput } from "../../../queries/actor/list-actor.ts";
import { showActor } from "../../../queries/actor/show-actor.ts";
import type { ShowActorInput } from "../../../queries/actor/show-actor.ts";
import { bindingOffenders, unimplementedFor } from "../app.ts";
import type {
  AppDependencies,
  Handler,
  HandlerContext,
  HandlerResult,
} from "../app.ts";
import type { ActorRow } from "../../../domain/actor.ts";
import type { Storage } from "../../../services/storage/index.ts";
import { registerActorHandler } from "./register-actor.ts";
import { listActorHandler } from "./list-actor.ts";
import { showActorHandler } from "./show-actor.ts";
import { revokeActorHandler } from "./revoke-actor.ts";
import { rotateActorTokenHandler } from "./rotate-actor-token.ts";

const ACTOR_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Y";
const ACTOR2_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Z";
const EVENT2_ULID = "01HZY8QF3M4N5P6R7S8T9V0W20";
const EVENT3_ULID = "01HZY8QF3M4N5P6R7S8T9V0W21";
const ROTATE_EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W22";
const SECOND_ROTATE_EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W23";
const UNKNOWN_ACTOR_ID = "actor_01HZY8QF3M4N5P6R7S8T9V0W24";
const WRONG_SECRET = "abc-def_ghijklmnopqrstuvwxyzABCDEFGHIJKLMNO";
const CONFIGURED_TOKEN = "test-token";
const HOST = "kanthord.test";
const FIVE_ACTOR_IDS = [
  "actor.register",
  "actor.list",
  "actor.show",
  "actor.revoke",
  "actor.rotate",
] as const;

describe("src/http/server/actor/registration.test", () => {
  type BuiltApp = Readonly<{
    app: TestApp;
    handlers: Readonly<Record<string, Handler>>;
    resolveActorFor: (presented: string) => ActorRow | null;
    received: ActorRow[];
    storage: Storage;
    blockNodeHandler(): Promise<void>;
    releaseNodeHandler(): void;
  }>;

  async function buildApp(
    t: TestContext,
    ulids: readonly string[],
  ): Promise<BuiltApp> {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const secret = new NodeCryptoSecret();
    const ids = createMockIdGenerator({ ulids });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
    const received: ActorRow[] = [];
    let gate: Promise<void> = Promise.resolve();
    let releaseGate: (() => void) | undefined;
    let enteredResolve: (() => void) | undefined;

    const nodeListHandler: Handler = async (
      context: HandlerContext,
    ): Promise<HandlerResult> => {
      received.push(context.actor);
      enteredResolve?.();
      await gate;
      return { status: 200, body: { nodes: [] } };
    };

    const handlers: Readonly<Record<string, Handler>> = {
      "actor.register": registerActorHandler({
        registerActor: (input: RegisterActorInput) =>
          registerActor(
            { storage: temporary.storage, secret, ids, events, clock },
            input,
          ),
        configuredToken: CONFIGURED_TOKEN,
      }),
      "actor.list": listActorHandler({
        listActors: (input: ListActorInput) =>
          listActors({ storage: temporary.storage }, input),
      }),
      "actor.show": showActorHandler({
        showActor: (input: ShowActorInput) =>
          showActor({ storage: temporary.storage }, input),
      }),
      "actor.revoke": revokeActorHandler({
        revokeActor: (input: RevokeActorInput) =>
          revokeActor({ storage: temporary.storage, events, clock }, input),
      }),
      "actor.rotate": rotateActorTokenHandler({
        rotateActorToken: (input: RotateActorTokenInput) =>
          rotateActorToken(
            { storage: temporary.storage, secret, events, clock },
            input,
          ),
      }),
      "node.list": nodeListHandler,
    };

    const resolveActorFor = (presented: string): ActorRow | null =>
      resolveActor(
        {
          storage: temporary.storage,
          secret,
          configuredToken: CONFIGURED_TOKEN,
        },
        { presented },
      );

    const app = await createTestApp({
      handlers,
      resolveActor: resolveActorFor,
    });

    return {
      app,
      handlers,
      resolveActorFor,
      received,
      storage: temporary.storage,
      blockNodeHandler(): Promise<void> {
        gate = new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
        return new Promise<void>((resolve) => {
          enteredResolve = resolve;
        });
      },
      releaseNodeHandler(): void {
        releaseGate?.();
        gate = Promise.resolve();
      },
    };
  }

  function nodeWithToken(app: TestApp, token: string) {
    return app.raw
      .get("/v1/node")
      .set("Host", HOST)
      .set("Authorization", `Bearer ${token}`);
  }

  it("the round trip: a harness registers through POST /v1/actor and reads GET /v1/node with its token", async (t) => {
    const { app, received } = await buildApp(t, [ACTOR_ULID, EVENT_ULID]);
    const registered = await app.post("/v1/actor").send({ name: "harness-1" });
    assert.equal(registered.status, 200);
    const token = registered.body.token as string;
    const registeredId = registered.body.id as string;

    const node = await nodeWithToken(app, token);
    assert.equal(node.status, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0]!.id, registeredId);
    assert.equal(received[0]!.kind, "harness");
  });

  it("unimplementedFor(handlers) names none of the five actor ids and bindingOffenders is empty", async (t) => {
    const built = await buildApp(t, []);
    const unimplemented = unimplementedFor(built.handlers);
    for (const operationId of FIVE_ACTOR_IDS) {
      assert.equal(
        unimplemented.includes(operationId),
        false,
        `${operationId} must be bound, not unimplemented`,
      );
    }
    const dependencies: AppDependencies = {
      settings: {
        token: CONFIGURED_TOKEN,
        allowedHosts: [HOST],
        allowedOrigins: [],
      },
      handlers: built.handlers,
      unimplemented,
      onInternalError: () => {},
      resolveActor: built.resolveActorFor,
    };
    assert.deepEqual(bindingOffenders(dependencies), []);
  });

  it("a revoked harness token answers 401 unauthenticated", async (t) => {
    const { app } = await buildApp(t, [ACTOR_ULID, EVENT_ULID, EVENT3_ULID]);
    const registered = await app.post("/v1/actor").send({ name: "harness-1" });
    assert.equal(registered.status, 200);
    const token = registered.body.token as string;
    const registeredId = registered.body.id as string;

    const revoked = await app.post(`/v1/actor/${registeredId}/revoke`);
    assert.equal(revoked.status, 200);

    const after = await nodeWithToken(app, token);
    assert.equal(after.status, 401);
    assert.equal(after.body.error.code, "unauthenticated");
  });

  it("a request authenticated before a revocation commit still completes; the next one is 401", async (t) => {
    const built = await buildApp(t, [ACTOR_ULID, EVENT_ULID, EVENT3_ULID]);
    const registered = await built.app
      .post("/v1/actor")
      .send({ name: "harness-1" });
    assert.equal(registered.status, 200);
    const token = registered.body.token as string;
    const registeredId = registered.body.id as string;

    const entered = built.blockNodeHandler();
    const pending = nodeWithToken(built.app, token).then(
      (response) => response,
    );
    await entered;
    const revoked = await built.app.post(`/v1/actor/${registeredId}/revoke`);
    assert.equal(revoked.status, 200);
    built.releaseNodeHandler();
    const first = await pending;
    assert.equal(first.status, 200);
    const second = await nodeWithToken(built.app, token);
    assert.equal(second.status, 401);
    assert.equal(second.body.error.code, "unauthenticated");
  });

  it("actor.rotate end to end: the new token works and the old one answers 401", async (t) => {
    const { app, received } = await buildApp(t, [
      ACTOR_ULID,
      EVENT_ULID,
      ACTOR2_ULID,
      EVENT2_ULID,
    ]);
    const registered = await app.post("/v1/actor").send({ name: "harness-2" });
    assert.equal(registered.status, 200);
    const oldToken = registered.body.token as string;
    const registeredId = registered.body.id as string;

    const before = await nodeWithToken(app, oldToken);
    assert.equal(before.status, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0]!.id, registeredId);
    assert.equal(received[0]!.kind, "harness");

    const rotated = await app.post(`/v1/actor/${registeredId}/rotate`);
    assert.equal(rotated.status, 200);
    const newToken = rotated.body.token as string;
    assert.notEqual(newToken, oldToken);

    const withOld = await nodeWithToken(app, oldToken);
    assert.equal(withOld.status, 401);
    assert.equal(withOld.body.error.code, "unauthenticated");

    const withNew = await nodeWithToken(app, newToken);
    assert.equal(withNew.status, 200);
  });

  it("actor.register with a harness token answers 403 actor-forbidden and writes nothing", async (t) => {
    const { app, storage } = await buildApp(t, [ACTOR_ULID, EVENT_ULID]);
    const registered = await app.post("/v1/actor").send({ name: "harness-1" });
    assert.equal(registered.status, 200);
    const harnessToken = registered.body.token as string;
    const beforeActor = tableBytes(storage, "actor");
    const beforeEvent = tableBytes(storage, "event");

    const refused = await app.raw
      .post("/v1/actor")
      .set("Host", HOST)
      .set("Authorization", `Bearer ${harnessToken}`)
      .send({ name: "harness-2" });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, "actor-forbidden");
    assert.equal(tableBytes(storage, "actor").equals(beforeActor), true);
    assert.equal(tableBytes(storage, "event").equals(beforeEvent), true);
  });

  it("actor.rotate with a harness token answers 403 actor-forbidden and writes nothing", async (t) => {
    const { app, storage } = await buildApp(t, [ACTOR_ULID, EVENT_ULID]);
    const registered = await app.post("/v1/actor").send({ name: "harness-1" });
    assert.equal(registered.status, 200);
    const harnessToken = registered.body.token as string;
    const registeredId = registered.body.id as string;
    const beforeActor = tableBytes(storage, "actor");
    const beforeEvent = tableBytes(storage, "event");

    const refused = await app.raw
      .post(`/v1/actor/${registeredId}/rotate`)
      .set("Host", HOST)
      .set("Authorization", `Bearer ${harnessToken}`);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, "actor-forbidden");
    assert.equal(tableBytes(storage, "actor").equals(beforeActor), true);
    assert.equal(tableBytes(storage, "event").equals(beforeEvent), true);
  });

  it("a revoked token, an unknown-id token and a wrong-secret token answer byte-identical 401 bodies", async (t) => {
    const { app } = await buildApp(t, [
      ACTOR_ULID,
      EVENT_ULID,
      ACTOR2_ULID,
      EVENT2_ULID,
      EVENT3_ULID,
    ]);
    const first = await app.post("/v1/actor").send({ name: "harness-1" });
    const second = await app.post("/v1/actor").send({ name: "harness-2" });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const revokedId = first.body.id as string;
    const liveId = second.body.id as string;
    const revoked = await app.post(`/v1/actor/${revokedId}/revoke`);
    assert.equal(revoked.status, 200);

    const revokedToken = first.body.token as string;
    const unknownToken = `${UNKNOWN_ACTOR_ID}.${WRONG_SECRET}`;
    const wrongToken = `${liveId}.${WRONG_SECRET}`;

    const live = await nodeWithToken(app, second.body.token as string);
    assert.equal(live.status, 200);

    const fromRevoked = await nodeWithToken(app, revokedToken);
    const fromUnknown = await nodeWithToken(app, unknownToken);
    const fromWrong = await nodeWithToken(app, wrongToken);
    assert.equal(fromRevoked.status, 401);
    assert.equal(fromUnknown.status, 401);
    assert.equal(fromWrong.status, 401);
    assert.equal(fromRevoked.text, fromUnknown.text);
    assert.equal(fromUnknown.text, fromWrong.text);
    assert.deepEqual(fromRevoked.body, fromUnknown.body);
    assert.deepEqual(fromUnknown.body, fromWrong.body);
  });

  it("after a new-key rotation the token from the first rotation answers 401 and the new token works", async (t) => {
    const { app } = await buildApp(t, [
      ACTOR_ULID,
      EVENT_ULID,
      ROTATE_EVENT_ULID,
      SECOND_ROTATE_EVENT_ULID,
    ]);
    const registered = await app.post("/v1/actor").send({ name: "harness-2" });
    assert.equal(registered.status, 200);
    const registeredId = registered.body.id as string;

    const first = await app
      .post(`/v1/actor/${registeredId}/rotate`)
      .set("Idempotency-Key", "k1");
    assert.equal(first.status, 200);
    const firstToken = first.body.token as string;

    const second = await app
      .post(`/v1/actor/${registeredId}/rotate`)
      .set("Idempotency-Key", "k2");
    assert.equal(second.status, 200);
    const secondToken = second.body.token as string;
    assert.notEqual(secondToken, firstToken);

    const withFirst = await nodeWithToken(app, firstToken);
    assert.equal(withFirst.status, 401);
    assert.equal(withFirst.body.error.code, "unauthenticated");

    const withSecond = await nodeWithToken(app, secondToken);
    assert.equal(withSecond.status, 200);
  });
});
