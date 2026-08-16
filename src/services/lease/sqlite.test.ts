import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SqliteLease } from "./sqlite.ts";
import { LeaseError } from "./index.ts";
import type { LeaseRefusal } from "../../domain/lease-hierarchy.ts";
import type { Storage } from "../storage/index.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
  seedSiblingTask,
} from "../../../test/helpers/rows.ts";

const now = 1700000000000;
const later = now + 1000;
const ttlMs = 300000;
const actorAlpha = "actor_alpha";
const actorBeta = "actor_beta";
const actorGamma = "actor_gamma";

function build(): {
  storage: Storage;
  lease: SqliteLease;
  dispose(): void;
} {
  const temporary = createMigratedStorage();
  temporary.storage.transact((transaction) => {
    seedRegistry(transaction);
    seedGraph(transaction);
    seedSiblingTask(transaction);
  });
  return {
    storage: temporary.storage,
    lease: new SqliteLease(),
    dispose: temporary.dispose,
  };
}

function insertLeaseRow(
  transaction: import("../storage/index.ts").Transaction,
  input: Readonly<{
    subjectId: string;
    owner: string;
    ownerKind: "daemon" | "actor";
    fence: number;
    acquiredAt: number;
    renewedAt: number;
    expiresAt: number;
  }>,
): void {
  transaction.run(
    "INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at) VALUES ('node', ?, ?, ?, ?, ?, ?, ?)",
    [
      input.subjectId,
      input.owner,
      input.ownerKind,
      input.fence,
      input.acquiredAt,
      input.renewedAt,
      input.expiresAt,
    ],
  );
}

function assertLeaseError(
  work: () => unknown,
  code: "lease-held" | "lease-fenced",
  refusal?: LeaseRefusal,
): void {
  assert.throws(work, (error: unknown) => {
    if (!(error instanceof LeaseError)) {
      throw error;
    }
    assert.equal(error.code, code);
    if (refusal !== undefined) {
      assert.deepEqual(
        (error as LeaseError & { refusal?: LeaseRefusal }).refusal,
        refusal,
      );
    }
    return true;
  });
}

describe("src/services/lease/sqlite.test", () => {
  it("a first acquire against an empty lease table inserts the row with fence 1", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        assert.deepEqual(transaction.all("SELECT * FROM lease"), []);
        const result = lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        assert.equal(result.acquired, true);
        assert.deepEqual(result.record, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          fence: 1,
          acquiredAt: now,
          renewedAt: now,
          expiresAt: now + ttlMs,
        });
      });
    } finally {
      dispose();
    }
  });

  it("the hierarchy read resolves the target from node and not from lease", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        assert.deepEqual(transaction.all("SELECT * FROM lease"), []);
        const task = lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        assert.equal(task.acquired, true);
        const initiative = lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "initiative_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        assert.equal(initiative.acquired, true);
      });
    } finally {
      dispose();
    }
  });

  it("an acquire of an unknown node throws a plain Error", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        assert.throws(
          () =>
            lease.acquire(transaction, {
              subjectKind: "node",
              subjectId: "task_zzz",
              owner: actorAlpha,
              ownerKind: "actor",
              now,
              ttlMs,
            }),
          (error: unknown) => {
            if (error instanceof LeaseError) {
              throw error;
            }
            return error instanceof Error;
          },
        );
      });
    } finally {
      dispose();
    }
  });

  it("the refusal carries the holder's fence", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        insertLeaseRow(transaction, {
          subjectId: "task_a",
          owner: actorBeta,
          ownerKind: "actor",
          fence: 5,
          acquiredAt: now,
          renewedAt: now,
          expiresAt: now + 9999,
        });
        assertLeaseError(
          () =>
            lease.acquire(transaction, {
              subjectKind: "node",
              subjectId: "task_a",
              owner: actorAlpha,
              ownerKind: "actor",
              now,
              ttlMs,
            }),
          "lease-held",
          {
            subjectId: "task_a",
            holder: actorBeta,
            holderKind: "actor",
            fence: 5,
            relation: "self",
            expiresAt: now + 9999,
          },
        );
      });
    } finally {
      dispose();
    }
  });

  it("a same-owner acquire of a live lease returns acquired false and moves no fence", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        const result = lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now: later,
          ttlMs,
        });
        assert.equal(result.acquired, false);
        assert.deepEqual(result.record, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          fence: 1,
          acquiredAt: now,
          renewedAt: later,
          expiresAt: later + ttlMs,
        });
      });
    } finally {
      dispose();
    }
  });

  it("an acquire over a free lease writes fence + 1", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        const first = lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        assert.equal(first.record.fence, 1);
        lease.release(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          fence: 1,
          now,
        });
        const second = lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorBeta,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        assert.equal(second.acquired, true);
        assert.equal(second.record.fence, 2);
        assert.equal(second.record.owner, actorBeta);
      });
    } finally {
      dispose();
    }
  });

  it("an acquire over an expired lease writes fence + 1", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        const result = lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorBeta,
          ownerKind: "actor",
          now: now + ttlMs,
          ttlMs,
        });
        assert.equal(result.acquired, true);
        assert.equal(result.record.fence, 2);
        assert.equal(result.record.owner, actorBeta);
      });
    } finally {
      dispose();
    }
  });

  it("an acquire over a pre-existing free row continues that row's fence and never resets to 1", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        transaction.run(
          "INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at) VALUES ('node', 'task_a', NULL, NULL, 7, NULL, NULL, NULL)",
        );
        const result = lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        assert.equal(result.acquired, true);
        assert.equal(result.record.fence, 8);
      });
    } finally {
      dispose();
    }
  });

  it("an acquire whose expires_at equals now exactly is admitted", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        const result = lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorBeta,
          ownerKind: "actor",
          now: now + ttlMs,
          ttlMs,
        });
        assert.equal(result.acquired, true);
        assert.equal(result.record.fence, 2);
        assert.equal(result.record.owner, actorBeta);
      });
    } finally {
      dispose();
    }
  });

  it("an acquire of a task held by another owner raises lease-held", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorBeta,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        assertLeaseError(
          () =>
            lease.acquire(transaction, {
              subjectKind: "node",
              subjectId: "task_a",
              owner: actorAlpha,
              ownerKind: "actor",
              now,
              ttlMs,
            }),
          "lease-held",
          {
            subjectId: "task_a",
            holder: actorBeta,
            holderKind: "actor",
            fence: 1,
            relation: "self",
            expiresAt: now + ttlMs,
          },
        );
      });
    } finally {
      dispose();
    }
  });

  it("an acquire of a task whose parent objective another owner holds raises lease-held with relation ancestor", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "objective_a",
          owner: actorBeta,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        assertLeaseError(
          () =>
            lease.acquire(transaction, {
              subjectKind: "node",
              subjectId: "task_a",
              owner: actorAlpha,
              ownerKind: "actor",
              now,
              ttlMs,
            }),
          "lease-held",
          {
            subjectId: "objective_a",
            holder: actorBeta,
            holderKind: "actor",
            fence: 1,
            relation: "ancestor",
            expiresAt: now + ttlMs,
          },
        );
      });
    } finally {
      dispose();
    }
  });

  it("an acquire of a task whose sibling another owner holds raises lease-held with relation sibling", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_b",
          owner: actorBeta,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        assertLeaseError(
          () =>
            lease.acquire(transaction, {
              subjectKind: "node",
              subjectId: "task_a",
              owner: actorAlpha,
              ownerKind: "actor",
              now,
              ttlMs,
            }),
          "lease-held",
          {
            subjectId: "task_b",
            holder: actorBeta,
            holderKind: "actor",
            fence: 1,
            relation: "sibling",
            expiresAt: now + ttlMs,
          },
        );
      });
    } finally {
      dispose();
    }
  });

  it("an acquire of an objective one of whose tasks another owner holds raises lease-held with relation descendant", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_b",
          owner: actorBeta,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        assertLeaseError(
          () =>
            lease.acquire(transaction, {
              subjectKind: "node",
              subjectId: "objective_a",
              owner: actorAlpha,
              ownerKind: "actor",
              now,
              ttlMs,
            }),
          "lease-held",
          {
            subjectId: "task_b",
            holder: actorBeta,
            holderKind: "actor",
            fence: 1,
            relation: "descendant",
            expiresAt: now + ttlMs,
          },
        );
      });
    } finally {
      dispose();
    }
  });

  it("an acquire of a task the same owner already holds at the objective succeeds", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        const objective = lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "objective_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        assert.equal(objective.acquired, true);
        const task = lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        assert.equal(task.acquired, true);
        assert.equal(task.record.fence, 1);
        assert.deepEqual(
          lease.read(transaction, {
            subjectKind: "node",
            subjectId: "objective_a",
            now,
          }),
          objective.record,
        );
      });
    } finally {
      dispose();
    }
  });

  it("renew with the current fence extends the expiry and moves no fence", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        const record = lease.renew(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          fence: 1,
          ttlMs,
          now: later,
        });
        assert.equal(record.fence, 1);
        assert.equal(record.renewedAt, later);
        assert.equal(record.expiresAt, later + ttlMs);
      });
    } finally {
      dispose();
    }
  });

  it("renew with any other fence raises lease-fenced and writes nothing", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        const before = lease.read(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          now,
        });
        assertLeaseError(
          () =>
            lease.renew(transaction, {
              subjectKind: "node",
              subjectId: "task_a",
              owner: actorAlpha,
              ownerKind: "actor",
              fence: 2,
              ttlMs,
              now: later,
            }),
          "lease-fenced",
        );
        assert.deepEqual(
          lease.read(transaction, {
            subjectKind: "node",
            subjectId: "task_a",
            now,
          }),
          before,
        );
      });
    } finally {
      dispose();
    }
  });

  it("renew with the wrong owner raises lease-fenced and writes nothing", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        const before = lease.read(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          now,
        });
        assertLeaseError(
          () =>
            lease.renew(transaction, {
              subjectKind: "node",
              subjectId: "task_a",
              owner: actorBeta,
              ownerKind: "actor",
              fence: 1,
              ttlMs,
              now: later,
            }),
          "lease-fenced",
        );
        assert.deepEqual(
          lease.read(transaction, {
            subjectKind: "node",
            subjectId: "task_a",
            now,
          }),
          before,
        );
      });
    } finally {
      dispose();
    }
  });

  it("renew of an expired holding raises lease-fenced and writes nothing", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        const before = lease.read(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          now,
        });
        assertLeaseError(
          () =>
            lease.renew(transaction, {
              subjectKind: "node",
              subjectId: "task_a",
              owner: actorAlpha,
              ownerKind: "actor",
              fence: 1,
              ttlMs,
              now: now + ttlMs,
            }),
          "lease-fenced",
        );
        assert.deepEqual(
          lease.read(transaction, {
            subjectKind: "node",
            subjectId: "task_a",
            now,
          }),
          before,
        );
      });
    } finally {
      dispose();
    }
  });

  it("release of an expired holding raises lease-fenced and writes nothing", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        const before = lease.read(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          now,
        });
        assertLeaseError(
          () =>
            lease.release(transaction, {
              subjectKind: "node",
              subjectId: "task_a",
              owner: actorAlpha,
              ownerKind: "actor",
              fence: 1,
              now: now + ttlMs,
            }),
          "lease-fenced",
        );
        assert.deepEqual(
          lease.read(transaction, {
            subjectKind: "node",
            subjectId: "task_a",
            now,
          }),
          before,
        );
      });
    } finally {
      dispose();
    }
  });

  it("assertHeld of an expired holding raises lease-fenced", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        assert.doesNotThrow(() =>
          lease.assertHeld(transaction, {
            subjectKind: "node",
            subjectId: "task_a",
            owner: actorAlpha,
            fence: 1,
            now,
          }),
        );
        assertLeaseError(
          () =>
            lease.assertHeld(transaction, {
              subjectKind: "node",
              subjectId: "task_a",
              owner: actorAlpha,
              fence: 1,
              now: now + ttlMs,
            }),
          "lease-fenced",
        );
      });
    } finally {
      dispose();
    }
  });

  it("release clears owner, owner kind, acquired_at, renewed_at and expires_at, and keeps the fence", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        lease.release(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          fence: 1,
          now,
        });
        const released = lease.read(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          now,
        });
        assert.ok(released !== null);
        assert.equal(released.owner, null);
        assert.equal(released.ownerKind, null);
        assert.equal(released.acquiredAt, null);
        assert.equal(released.renewedAt, null);
        assert.equal(released.expiresAt, null);
        assert.equal(released.fence, 1);
      });
    } finally {
      dispose();
    }
  });

  it("a released row holds a null in every column but the fence", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        lease.release(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          fence: 1,
          now,
        });
        assert.deepEqual(
          lease.read(transaction, {
            subjectKind: "node",
            subjectId: "task_a",
            now,
          }),
          {
            subjectKind: "node",
            subjectId: "task_a",
            owner: null,
            ownerKind: null,
            fence: 1,
            acquiredAt: null,
            renewedAt: null,
            expiresAt: null,
          },
        );
      });
    } finally {
      dispose();
    }
  });

  it("release with the right fence and the wrong owner raises lease-fenced and writes nothing", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        const before = lease.read(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          now,
        });
        assertLeaseError(
          () =>
            lease.release(transaction, {
              subjectKind: "node",
              subjectId: "task_a",
              owner: actorBeta,
              ownerKind: "actor",
              fence: 1,
              now,
            }),
          "lease-fenced",
        );
        assert.deepEqual(
          lease.read(transaction, {
            subjectKind: "node",
            subjectId: "task_a",
            now,
          }),
          before,
        );
      });
    } finally {
      dispose();
    }
  });

  it("release with the right owner and the wrong fence raises lease-fenced and writes nothing", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        const before = lease.read(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          now,
        });
        assertLeaseError(
          () =>
            lease.release(transaction, {
              subjectKind: "node",
              subjectId: "task_a",
              owner: actorAlpha,
              ownerKind: "actor",
              fence: 2,
              now,
            }),
          "lease-fenced",
        );
        assert.deepEqual(
          lease.read(transaction, {
            subjectKind: "node",
            subjectId: "task_a",
            now,
          }),
          before,
        );
      });
    } finally {
      dispose();
    }
  });

  it("expired returns every node lease at or before now, ordered by subject id", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        insertLeaseRow(transaction, {
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          fence: 1,
          acquiredAt: 100,
          renewedAt: 100,
          expiresAt: now - 1000,
        });
        insertLeaseRow(transaction, {
          subjectId: "objective_a",
          owner: actorBeta,
          ownerKind: "actor",
          fence: 1,
          acquiredAt: 200,
          renewedAt: 200,
          expiresAt: now - 500,
        });
        insertLeaseRow(transaction, {
          subjectId: "task_b",
          owner: actorGamma,
          ownerKind: "actor",
          fence: 1,
          acquiredAt: 300,
          renewedAt: 300,
          expiresAt: now + 99999,
        });
        assert.deepEqual(lease.expired(transaction, now), [
          {
            subjectKind: "node",
            subjectId: "objective_a",
            owner: actorBeta,
            ownerKind: "actor",
            fence: 1,
            acquiredAt: 200,
            renewedAt: 200,
            expiresAt: now - 500,
          },
          {
            subjectKind: "node",
            subjectId: "task_a",
            owner: actorAlpha,
            ownerKind: "actor",
            fence: 1,
            acquiredAt: 100,
            renewedAt: 100,
            expiresAt: now - 1000,
          },
        ]);
      });
    } finally {
      dispose();
    }
  });

  it("expireLeasesOfOwner sets expires_at to now and keeps owner, owner kind and fence", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "objective_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        const subjects = lease.expireLeasesOfOwner(transaction, {
          owner: actorAlpha,
          now: later,
        });
        assert.deepEqual(subjects, [
          { subjectKind: "node", subjectId: "objective_a" },
          { subjectKind: "node", subjectId: "task_a" },
        ]);
        assert.deepEqual(
          lease.read(transaction, {
            subjectKind: "node",
            subjectId: "objective_a",
            now,
          }),
          {
            subjectKind: "node",
            subjectId: "objective_a",
            owner: actorAlpha,
            ownerKind: "actor",
            fence: 1,
            acquiredAt: now,
            renewedAt: now,
            expiresAt: later,
          },
        );
        assert.deepEqual(
          lease.read(transaction, {
            subjectKind: "node",
            subjectId: "task_a",
            now,
          }),
          {
            subjectKind: "node",
            subjectId: "task_a",
            owner: actorAlpha,
            ownerKind: "actor",
            fence: 1,
            acquiredAt: now,
            renewedAt: now,
            expiresAt: later,
          },
        );
      });
    } finally {
      dispose();
    }
  });

  it("expireLeasesOfOwner touches no lease of another owner", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "objective_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        insertLeaseRow(transaction, {
          subjectId: "task_b",
          owner: actorBeta,
          ownerKind: "actor",
          fence: 1,
          acquiredAt: now,
          renewedAt: now,
          expiresAt: later,
        });
        const before = lease.read(transaction, {
          subjectKind: "node",
          subjectId: "task_b",
          now,
        });
        lease.expireLeasesOfOwner(transaction, {
          owner: actorAlpha,
          now: later,
        });
        assert.deepEqual(
          lease.read(transaction, {
            subjectKind: "node",
            subjectId: "task_b",
            now,
          }),
          before,
        );
      });
    } finally {
      dispose();
    }
  });

  it("expireLeasesOfOwner over an owner with no live lease returns an empty list and writes nothing", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        const before = lease.read(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          now,
        });
        assert.deepEqual(
          lease.expireLeasesOfOwner(transaction, {
            owner: actorGamma,
            now: later,
          }),
          [],
        );
        assert.deepEqual(
          lease.read(transaction, {
            subjectKind: "node",
            subjectId: "task_a",
            now,
          }),
          before,
        );
      });
    } finally {
      dispose();
    }
  });

  it("read returns the record or null", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        const record = lease.read(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          now,
        });
        assert.ok(record !== null);
        assert.equal(record.owner, actorAlpha);
        assert.equal(
          lease.read(transaction, {
            subjectKind: "node",
            subjectId: "task_b",
            now,
          }),
          null,
        );
      });
    } finally {
      dispose();
    }
  });

  it("assertHeld passes for the live owner and fence, and raises lease-fenced for an absent row, a wrong owner and a wrong fence", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        lease.acquire(transaction, {
          subjectKind: "node",
          subjectId: "task_a",
          owner: actorAlpha,
          ownerKind: "actor",
          now,
          ttlMs,
        });
        assert.doesNotThrow(() =>
          lease.assertHeld(transaction, {
            subjectKind: "node",
            subjectId: "task_a",
            owner: actorAlpha,
            fence: 1,
            now,
          }),
        );
        assertLeaseError(
          () =>
            lease.assertHeld(transaction, {
              subjectKind: "node",
              subjectId: "task_b",
              owner: actorAlpha,
              fence: 1,
              now,
            }),
          "lease-fenced",
        );
        assertLeaseError(
          () =>
            lease.assertHeld(transaction, {
              subjectKind: "node",
              subjectId: "task_a",
              owner: actorBeta,
              fence: 1,
              now,
            }),
          "lease-fenced",
        );
        assertLeaseError(
          () =>
            lease.assertHeld(transaction, {
              subjectKind: "node",
              subjectId: "task_a",
              owner: actorAlpha,
              fence: 2,
              now,
            }),
          "lease-fenced",
        );
      });
    } finally {
      dispose();
    }
  });

  it("every input carries now and the service reads no clock", () => {
    const source = readFileSync(
      new URL("./sqlite.ts", import.meta.url),
      "utf8",
    );
    assert.ok(!source.includes("Date.now("));
    assert.ok(!source.includes("new Date("));
    assert.ok(!/from\s+["']\.\.\/clock\//.test(source));
  });

  it("an acquire on a repository subject throws", () => {
    const { storage, lease, dispose } = build();
    try {
      storage.transact((transaction) => {
        assert.throws(
          () =>
            lease.acquire(transaction, {
              subjectKind: "repository",
              subjectId: "repo_a",
              owner: actorAlpha,
              ownerKind: "actor",
              now,
              ttlMs,
            }),
          (error: unknown) => {
            if (error instanceof LeaseError) {
              throw error;
            }
            assert.ok(error instanceof Error);
            assert.match(error.message, /repository/);
            return true;
          },
        );
      });
    } finally {
      dispose();
    }
  });
});
