import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { NodeCryptoSecret } from "../../services/secret/node-crypto.ts";
import type { Secret } from "../../services/secret/index.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import { bootstrapActorId } from "../../domain/actor.ts";
import { BOOTSTRAP_ACTOR_FIXTURE } from "../../../test/helpers/app.ts";
import {
  createMigratedStorage,
  tableBytes,
} from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { createBackedLeaseFake } from "../../../test/helpers/lease.ts";
import {
  fixtureIds,
  seedGraph,
  seedNodeState,
  seedRegistry,
  seedSecondProjectGraph,
} from "../../../test/helpers/rows.ts";
import { ActorCommandError } from "../../domain/actor-command-error.ts";
import { registerActor } from "./register-actor.ts";
import { revokeActor } from "./revoke-actor.ts";

const ACTOR_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Y";
const REVOKE_EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Z";
const SECOND_ACTOR_ULID = "01HZY8QF3M4N5P6R7S8T9V0W2A";
const SECOND_EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W2B";
const NOW = 1700000000000;
const STEP = 1000;
const TTL = 300000;
const REVOKE_INSTANT = NOW + STEP;
const actorId = `actor_${ACTOR_ULID}`;

type ActorRowReadback = Readonly<{
  id: string;
  kind: string;
  name: string;
  token_sha256: Uint8Array | null;
  registered_by: string | null;
  created_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
}>;

type EventRowReadback = Readonly<{
  id: string;
  subject_kind: string;
  subject_id: string;
  type: string;
  actor_kind: string;
  actor_id: string;
  payload_json: string;
}>;

type LeaseRowReadback = Readonly<{
  subject_kind: string;
  subject_id: string;
  owner: string | null;
  owner_kind: string | null;
  fence: number;
  acquired_at: number | null;
  renewed_at: number | null;
  expires_at: number | null;
}>;

describe("src/commands/actor/revoke-actor.test", () => {
  const secret: Secret = new NodeCryptoSecret();

  function registerDependencies(
    storage: Storage,
    ids: IdGenerator,
    clock: Clock,
  ) {
    return {
      storage,
      secret,
      ids,
      clock,
      events: new SqliteEventLog({ storage, ids }),
    };
  }

  function registerOne(
    storage: Storage,
    ids: IdGenerator,
    clock: Clock,
    name = "worker-a",
  ): { id: string; token: string } {
    const result = registerActor(registerDependencies(storage, ids, clock), {
      name,
      actor: BOOTSTRAP_ACTOR_FIXTURE,
      configuredToken: "test-token",
    });
    return { id: result.view.id, token: result.token };
  }

  function readActor(storage: Storage, id: string): ActorRowReadback {
    return storage.transact((transaction) =>
      transaction.get(
        "SELECT id, kind, name, token_sha256, registered_by, created_at, revoked_at, revoked_by FROM actor WHERE id = ?",
        [id],
      ),
    ) as ActorRowReadback;
  }

  function readEvents(storage: Storage): readonly EventRowReadback[] {
    return storage.transact((transaction) =>
      transaction.all(
        "SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event",
      ),
    ) as readonly EventRowReadback[];
  }

  function readLeaseRows(storage: Storage): readonly LeaseRowReadback[] {
    return storage.transact((transaction) =>
      transaction.all(
        "SELECT subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at FROM lease ORDER BY subject_id",
      ),
    ) as readonly LeaseRowReadback[];
  }

  function readTableRows(storage: Storage, table: string): readonly unknown[] {
    return storage.transact((transaction) =>
      transaction.all(`SELECT * FROM ${table} ORDER BY id`),
    );
  }

  function revokedPayload(storage: Storage): Record<string, unknown> {
    const revokedEvents = readEvents(storage).filter(
      (event) => event.type === "actor.revoked",
    );
    assert.equal(revokedEvents.length, 1);
    return JSON.parse(revokedEvents[0]!.payload_json) as Record<
      string,
      unknown
    >;
  }

  // The state a claim leaves: a live objective lease and a live task lease of
  // the harness, seeded directly because this suite calls no other command.
  function seedLeaseForActor(
    transaction: Transaction,
    subjectId: string,
    owner: string,
    fence: number,
  ): void {
    transaction.run(
      "INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at) VALUES ('node', ?, ?, 'actor', ?, ?, ?, ?)",
      [subjectId, owner, fence, NOW, NOW, NOW + TTL],
    );
  }

  function seedHarnessExecution(transaction: Transaction): void {
    transaction.run(
      "INSERT INTO run (id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, judged_oid, graph_revision, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at) VALUES (?, 'structural', ?, 'external', NULL, ?, ?, 3, NULL, NULL, NULL, '[]', ?, ?, 'active', NULL, NULL)",
      [
        fixtureIds.objectiveRun,
        fixtureIds.objective,
        "general@1",
        3,
        NOW + TTL,
        NOW + TTL,
      ],
    );
    transaction.run(
      "INSERT INTO run (id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, judged_oid, graph_revision, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at) VALUES (?, 'execution', ?, 'external', NULL, ?, ?, 3, NULL, NULL, NULL, '[]', ?, ?, 'active', NULL, NULL)",
      [
        fixtureIds.taskRun,
        fixtureIds.task,
        "general@1",
        1,
        NOW + TTL,
        NOW + TTL,
      ],
    );
    transaction.run(
      "INSERT INTO attempt (id, run_id, driver, attempt_no, provider_id, provider_model, timeout_ms, base_oid, head_oid, outcome, ended_at) VALUES (?, ?, 'external', 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
      [fixtureIds.attempt, fixtureIds.taskRun],
    );
  }

  function createHarnessWithLeases(): Readonly<{
    storage: Storage;
    events: EventLog;
    clock: Clock;
    harnessId: string;
    lease: ReturnType<typeof createBackedLeaseFake>;
    dispose(): void;
  }> {
    const temporary = createMigratedStorage();
    const ids = createMockIdGenerator({
      ulids: [ACTOR_ULID, EVENT_ULID, REVOKE_EVENT_ULID],
    });
    const clock = createMockClock({ start: NOW, step: STEP });
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
    const registered = registerOne(temporary.storage, ids, clock);
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      seedLeaseForActor(transaction, fixtureIds.objective, registered.id, 3);
      seedLeaseForActor(transaction, fixtureIds.task, registered.id, 1);
    });
    return {
      storage: temporary.storage,
      events,
      clock,
      harnessId: registered.id,
      lease: createBackedLeaseFake(),
      dispose() {
        temporary.dispose();
      },
    };
  }

  it("a revoke stamps revoked_at and revoked_by and appends exactly one actor.revoked event", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [ACTOR_ULID, EVENT_ULID, REVOKE_EVENT_ULID],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const registered = registerOne(temporary.storage, ids, clock);
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
    const lease = createBackedLeaseFake();

    const view = revokeActor(
      {
        storage: temporary.storage,
        events,
        clock,
        lease: lease.lease,
      },
      { id: registered.id, actor: BOOTSTRAP_ACTOR_FIXTURE },
    );
    assert.equal(view.id, registered.id);
    assert.equal(view.name, "worker-a");
    assert.equal(view.revokedAt, 1700000001000);
    assert.equal(view.revokedBy, bootstrapActorId);

    const row = readActor(temporary.storage, registered.id);
    assert.equal(row.revoked_at, 1700000001000);
    assert.equal(row.revoked_by, bootstrapActorId);

    const revokedEvents = readEvents(temporary.storage).filter(
      (event) => event.type === "actor.revoked",
    );
    assert.equal(revokedEvents.length, 1);
    const event = revokedEvents[0]!;
    assert.equal(event.subject_kind, "actor");
    assert.equal(event.subject_id, registered.id);
    assert.equal(event.actor_kind, "human");
    assert.equal(event.actor_id, bootstrapActorId);
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), [
      "actorId",
      "kind",
      "leasesFenced",
      "name",
      "revokedAt",
      "revokedBy",
    ]);
    assert.equal(payload.revokedBy, bootstrapActorId);
    assert.equal(payload.leasesFenced, 0);
    assert.equal(payload.revokedAt, 1700000001000);
  });

  it("a second revoke returns the same view, writes nothing and appends no second event", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [ACTOR_ULID, EVENT_ULID, REVOKE_EVENT_ULID],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const registered = registerOne(temporary.storage, ids, clock);
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
    const lease = createBackedLeaseFake();
    const deps = {
      storage: temporary.storage,
      events,
      clock,
      lease: lease.lease,
    };
    const first = revokeActor(deps, {
      id: registered.id,
      actor: BOOTSTRAP_ACTOR_FIXTURE,
    });
    const before = readActor(temporary.storage, registered.id);

    const second = revokeActor(deps, {
      id: registered.id,
      actor: BOOTSTRAP_ACTOR_FIXTURE,
    });
    assert.deepEqual(second, first);
    assert.deepEqual(readActor(temporary.storage, registered.id), before);
    assert.equal(
      readEvents(temporary.storage).filter(
        (event) => event.type === "actor.revoked",
      ).length,
      1,
    );
  });

  it("revoking the bootstrap actor throws bootstrap-actor and writes nothing", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [ACTOR_ULID, EVENT_ULID] });
    const clock = createMockClock({ start: NOW, step: STEP });
    registerOne(temporary.storage, ids, clock);
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
    const lease = createBackedLeaseFake();
    const beforeActor = tableBytes(temporary.storage, "actor");
    const beforeEvent = tableBytes(temporary.storage, "event");

    assert.throws(
      () =>
        revokeActor(
          {
            storage: temporary.storage,
            events,
            clock,
            lease: lease.lease,
          },
          { id: bootstrapActorId, actor: BOOTSTRAP_ACTOR_FIXTURE },
        ),
      (error: unknown) =>
        error instanceof ActorCommandError &&
        error.refusal === "bootstrap-actor",
    );
    assert.equal(
      tableBytes(temporary.storage, "actor").equals(beforeActor),
      true,
    );
    assert.equal(
      tableBytes(temporary.storage, "event").equals(beforeEvent),
      true,
    );
  });

  it("an unknown id throws not-found", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [] });
    const clock = createMockClock({ start: NOW, step: STEP });
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
    const lease = createBackedLeaseFake();

    assert.throws(
      () =>
        revokeActor(
          {
            storage: temporary.storage,
            events,
            clock,
            lease: lease.lease,
          },
          { id: `actor_${REVOKE_EVENT_ULID}`, actor: BOOTSTRAP_ACTOR_FIXTURE },
        ),
      (error: unknown) =>
        error instanceof ActorCommandError && error.refusal === "not-found",
    );
  });

  it("a rolled-back revocation leaves no event and no stamp", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [ACTOR_ULID, EVENT_ULID],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const registered = registerOne(temporary.storage, ids, clock);
    const inner = new SqliteEventLog({ storage: temporary.storage, ids });
    const lease = createBackedLeaseFake();
    const events: EventLog = {
      append() {
        throw new Error("event append fails");
      },
      list(filter, transaction) {
        return inner.list(filter, transaction);
      },
    };
    const beforeActor = tableBytes(temporary.storage, "actor");
    const beforeEvent = tableBytes(temporary.storage, "event");

    assert.throws(
      () =>
        revokeActor(
          { storage: temporary.storage, events, clock, lease: lease.lease },
          { id: registered.id, actor: BOOTSTRAP_ACTOR_FIXTURE },
        ),
      (error: unknown) =>
        error instanceof Error && error.message === "event append fails",
    );
    const row = readActor(temporary.storage, registered.id);
    assert.equal(row.revoked_at, null);
    assert.equal(row.revoked_by, null);
    assert.equal(
      readEvents(temporary.storage).filter(
        (event) => event.type === "actor.revoked",
      ).length,
      0,
    );
    assert.equal(
      tableBytes(temporary.storage, "actor").equals(beforeActor),
      true,
    );
    assert.equal(
      tableBytes(temporary.storage, "event").equals(beforeEvent),
      true,
    );
  });

  it("a revocation fences both the task lease and the objective lease of a harness", (t) => {
    const fixture = createHarnessWithLeases();
    t.after(() => fixture.dispose());
    const before = readLeaseRows(fixture.storage);

    revokeActor(
      {
        storage: fixture.storage,
        events: fixture.events,
        clock: fixture.clock,
        lease: fixture.lease.lease,
      },
      { id: fixture.harnessId, actor: BOOTSTRAP_ACTOR_FIXTURE },
    );

    const after = readLeaseRows(fixture.storage);
    assert.equal(after.length, 2);
    for (const subjectId of [fixtureIds.objective, fixtureIds.task]) {
      const prior = before.find((row) => row.subject_id === subjectId);
      const current = after.find((row) => row.subject_id === subjectId);
      assert.ok(prior !== undefined, `prior lease row of ${subjectId} absent`);
      assert.ok(current !== undefined, `lease row of ${subjectId} absent`);
      assert.equal(current.expires_at, REVOKE_INSTANT);
      assert.equal(current.owner, prior.owner);
      assert.equal(current.owner_kind, prior.owner_kind);
      assert.equal(current.fence, prior.fence);
    }
  });

  it("the actor.revoked payload carries leasesFenced 2", (t) => {
    const fixture = createHarnessWithLeases();
    t.after(() => fixture.dispose());

    revokeActor(
      {
        storage: fixture.storage,
        events: fixture.events,
        clock: fixture.clock,
        lease: fixture.lease.lease,
      },
      { id: fixture.harnessId, actor: BOOTSTRAP_ACTOR_FIXTURE },
    );

    assert.equal(revokedPayload(fixture.storage).leasesFenced, 2);
  });

  it("a revocation closes no attempt, ends no run and moves no node state", (t) => {
    const fixture = createHarnessWithLeases();
    t.after(() => fixture.dispose());
    fixture.storage.transact((transaction) => {
      seedNodeState(transaction, fixtureIds.initiative, "running");
      seedNodeState(transaction, fixtureIds.objective, "running");
      seedNodeState(transaction, fixtureIds.task, "running");
      seedHarnessExecution(transaction);
    });
    const beforeAttempt = readTableRows(fixture.storage, "attempt");
    const beforeRun = readTableRows(fixture.storage, "run");
    const beforeNode = readTableRows(fixture.storage, "node");

    revokeActor(
      {
        storage: fixture.storage,
        events: fixture.events,
        clock: fixture.clock,
        lease: fixture.lease.lease,
      },
      { id: fixture.harnessId, actor: BOOTSTRAP_ACTOR_FIXTURE },
    );

    assert.deepEqual(readTableRows(fixture.storage, "attempt"), beforeAttempt);
    assert.deepEqual(readTableRows(fixture.storage, "run"), beforeRun);
    assert.deepEqual(readTableRows(fixture.storage, "node"), beforeNode);
  });

  it("a revoked actor with no lease records leasesFenced 0 and writes no lease row", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [ACTOR_ULID, EVENT_ULID, REVOKE_EVENT_ULID],
    });
    const clock = createMockClock({ start: NOW, step: STEP });
    const registered = registerOne(temporary.storage, ids, clock);
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
    const lease = createBackedLeaseFake();
    const before = readLeaseRows(temporary.storage);

    revokeActor(
      { storage: temporary.storage, events, clock, lease: lease.lease },
      { id: registered.id, actor: BOOTSTRAP_ACTOR_FIXTURE },
    );

    assert.equal(revokedPayload(temporary.storage).leasesFenced, 0);
    assert.deepEqual(readLeaseRows(temporary.storage), before);
  });

  it("the fenced rows are sweepable", (t) => {
    const fixture = createHarnessWithLeases();
    t.after(() => fixture.dispose());

    revokeActor(
      {
        storage: fixture.storage,
        events: fixture.events,
        clock: fixture.clock,
        lease: fixture.lease.lease,
      },
      { id: fixture.harnessId, actor: BOOTSTRAP_ACTOR_FIXTURE },
    );

    const sweepable = fixture.storage.transact((transaction) =>
      transaction.all(
        "SELECT subject_id FROM lease WHERE subject_kind = 'node' AND subject_id IN (?, ?) AND owner IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= ?",
        [fixtureIds.objective, fixtureIds.task, REVOKE_INSTANT],
      ),
    ) as readonly Readonly<{ subject_id: string }>[];
    assert.deepEqual(
      sweepable.map((row) => row.subject_id).sort(),
      [fixtureIds.objective, fixtureIds.task].sort(),
    );
  });

  it("a revocation touches no lease of another actor", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [
        ACTOR_ULID,
        EVENT_ULID,
        SECOND_ACTOR_ULID,
        SECOND_EVENT_ULID,
        REVOKE_EVENT_ULID,
      ],
    });
    const clock = createMockClock({ start: NOW, step: STEP });
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
    const first = registerOne(temporary.storage, ids, clock, "worker-a");
    const second = registerOne(temporary.storage, ids, clock, "worker-b");
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      seedSecondProjectGraph(transaction);
      seedLeaseForActor(transaction, fixtureIds.objective, first.id, 3);
      seedLeaseForActor(transaction, fixtureIds.task, first.id, 1);
      seedLeaseForActor(transaction, "objective_pb", second.id, 2);
      seedLeaseForActor(transaction, "task_pb", second.id, 1);
    });
    const lease = createBackedLeaseFake();
    const before = readLeaseRows(temporary.storage);

    revokeActor(
      { storage: temporary.storage, events, clock, lease: lease.lease },
      { id: first.id, actor: BOOTSTRAP_ACTOR_FIXTURE },
    );

    const after = readLeaseRows(temporary.storage);
    assert.equal(before.filter((row) => row.owner === second.id).length, 2);
    assert.deepEqual(
      after.filter((row) => row.owner === second.id),
      before.filter((row) => row.owner === second.id),
    );
  });

  it("revoking the bootstrap actor is still refused and fences nothing", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [] });
    const clock = createMockClock({ start: NOW, step: STEP });
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
    temporary.storage.transact((transaction) => {
      seedLeaseForActor(transaction, fixtureIds.objective, bootstrapActorId, 3);
    });
    const lease = createBackedLeaseFake();
    const before = readLeaseRows(temporary.storage);

    assert.throws(
      () =>
        revokeActor(
          { storage: temporary.storage, events, clock, lease: lease.lease },
          { id: bootstrapActorId, actor: BOOTSTRAP_ACTOR_FIXTURE },
        ),
      (error: unknown) =>
        error instanceof ActorCommandError &&
        error.refusal === "bootstrap-actor",
    );
    assert.deepEqual(readLeaseRows(temporary.storage), before);
  });
});
