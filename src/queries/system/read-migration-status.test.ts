import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readMigrationStatus } from "./read-migration-status.ts";
import type { MigrationStatus } from "../../services/storage/index.ts";
import { systemDbResponse } from "../../http/contract/system.ts";

type FakeStorage = Readonly<{
  transact: () => never;
  migrate: () => never;
  status: () => MigrationStatus;
  close: () => never;
  ping: () => void;
}>;

const makeFake = (
  status: MigrationStatus,
): {
  fake: FakeStorage;
  counts: { transact: number; migrate: number; close: number; ping: number };
} => {
  const counts = { transact: 0, migrate: 0, close: 0, ping: 0 };
  const fake: FakeStorage = {
    transact: () => {
      counts.transact += 1;
      throw new Error("transact must not be called");
    },
    migrate: () => {
      counts.migrate += 1;
      throw new Error("migrate must not be called");
    },
    status: () => status,
    close: () => {
      counts.close += 1;
      throw new Error("close must not be called");
    },
    ping: () => {
      counts.ping += 1;
      throw new Error("ping must not be called");
    },
  };
  return { fake, counts };
};

describe("src/queries/system/read-migration-status.test", () => {
  it("both lists empty gives an empty migrations list", () => {
    const { fake } = makeFake({ applied: [], pending: [] });
    assert.deepEqual(readMigrationStatus({ storage: fake }), {
      migrations: [],
    });
  });

  it("maps applied and pending entries into one version-ordered list", () => {
    const { fake } = makeFake({
      applied: [
        { version: 1, name: "0001-core-entities", appliedAt: 1700000000 },
      ],
      pending: [
        { version: 2, name: "0002-graph-and-plan" },
        { version: 3, name: "0003-execution-and-journal" },
      ],
    });
    assert.deepEqual(readMigrationStatus({ storage: fake }), {
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
        {
          version: 3,
          name: "0003-execution-and-journal",
          applied: false,
          appliedAt: null,
        },
      ],
    });
  });

  it("sorts interleaved and out-of-order input by version", () => {
    const { fake } = makeFake({
      applied: [
        { version: 3, name: "0003-execution-and-journal", appliedAt: 3 },
      ],
      pending: [
        { version: 1, name: "0001-core-entities" },
        { version: 2, name: "0002-graph-and-plan" },
      ],
    });
    const result = readMigrationStatus({ storage: fake });
    assert.deepEqual(
      result.migrations.map((entry) => entry.version),
      [1, 2, 3],
    );
  });

  it("each result passes systemDbResponse.parse", () => {
    const { fake } = makeFake({
      applied: [
        { version: 1, name: "0001-core-entities", appliedAt: 1700000000 },
      ],
      pending: [{ version: 2, name: "0002-graph-and-plan" }],
    });
    const result = readMigrationStatus({ storage: fake });
    assert.equal(systemDbResponse.safeParse(result).success, true);
  });

  it("transact, migrate, close and ping are never called", () => {
    const { fake, counts } = makeFake({ applied: [], pending: [] });
    readMigrationStatus({ storage: fake });
    assert.equal(counts.transact, 0);
    assert.equal(counts.migrate, 0);
    assert.equal(counts.close, 0);
    assert.equal(counts.ping, 0);
  });
});
