import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  dependencyStatuses,
  systemDbResponse,
  systemHealthResponse,
} from "./system.ts";
import { findOperation, registry } from "./registry.ts";
import type { Operation } from "./operation.ts";

const bannedPropertyNames = [
  "path",
  "filePath",
  "dir",
  "directory",
  "cwd",
  "home",
  "gitDir",
  "workspacePath",
  "absolutePath",
];

function collectPropertyNames(schema: unknown, into: Set<string>): void {
  if (typeof schema !== "object" || schema === null) {
    return;
  }
  const record = schema as Readonly<Record<string, unknown>>;
  const properties = record.properties;
  if (typeof properties === "object" && properties !== null) {
    for (const [key, child] of Object.entries(
      properties as Readonly<Record<string, unknown>>,
    )) {
      into.add(key);
      collectPropertyNames(child, into);
    }
  }
  if (record.items !== undefined) {
    collectPropertyNames(record.items, into);
  }
}

const propertyNamesOf = (
  entries: readonly Operation[],
  io: "input" | "output",
): Set<string> => {
  const names = new Set<string>();
  for (const entry of entries) {
    const schema = io === "input" ? entry.request : entry.response;
    if (schema === undefined) {
      continue;
    }
    collectPropertyNames(
      z.toJSONSchema(schema, { target: "openapi-3.0", io }),
      names,
    );
  }
  return names;
};

describe("src/http/contract/system.test", () => {
  it("systemHealthResponse accepts an empty and a two-line dependency list", () => {
    assert.equal(
      systemHealthResponse.safeParse({ status: "ok", dependencies: [] })
        .success,
      true,
    );
    assert.equal(
      systemHealthResponse.safeParse({
        status: "degraded",
        dependencies: [
          { name: "storage", status: "ok" },
          { name: "git", status: "failed" },
        ],
      }).success,
      true,
    );
  });

  it("systemHealthResponse rejects every non-contract shape", () => {
    const rejected = [
      { status: "ok" },
      { status: "up", dependencies: [] },
      { status: "ok", dependencies: [], version: "27.8.1" },
      { status: "ok", dependencies: [{ name: "", status: "ok" }] },
      { status: "ok", dependencies: [{ name: "storage", status: "fine" }] },
      {
        status: "ok",
        dependencies: [{ name: "storage", status: "ok", extra: 1 }],
      },
    ];
    for (const value of rejected) {
      assert.equal(
        systemHealthResponse.safeParse(value).success,
        false,
        `accepted ${JSON.stringify(value)}`,
      );
    }
  });

  it("dependencyStatuses pins the three statuses", () => {
    assert.deepEqual(dependencyStatuses, ["ok", "failed", "not-implemented"]);
  });

  it("systemDbResponse accepts the empty and the two-line migration list", () => {
    assert.equal(systemDbResponse.safeParse({ migrations: [] }).success, true);
    assert.equal(
      systemDbResponse.safeParse({
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
      }).success,
      true,
    );
  });

  it("systemDbResponse rejects every non-contract shape", () => {
    const rejected = [
      {},
      {
        migrations: [{ version: 0, name: "x", applied: true, appliedAt: 1 }],
      },
      {
        migrations: [{ version: 1.5, name: "x", applied: true, appliedAt: 1 }],
      },
      { migrations: [{ version: 1, name: "", applied: true, appliedAt: 1 }] },
      {
        migrations: [
          { version: 1, name: "x", applied: true, appliedAt: "1700000000" },
        ],
      },
      { migrations: [], extra: 1 },
    ];
    for (const value of rejected) {
      assert.equal(
        systemDbResponse.safeParse(value).success,
        false,
        `accepted ${JSON.stringify(value)}`,
      );
    }
  });

  it("binds systemHealthResponse to system.health and systemDbResponse to system.db", () => {
    assert.strictEqual(
      findOperation("system.health")?.response,
      systemHealthResponse,
    );
    assert.strictEqual(findOperation("system.db")?.response, systemDbResponse);
  });

  it("system.health and system.db carry no request schema", () => {
    assert.equal(findOperation("system.health")?.request, undefined);
    assert.equal(findOperation("system.db")?.request, undefined);
  });

  it("system.status and blob.show carry no response schema", () => {
    assert.equal(findOperation("system.status")?.response, undefined);
    assert.equal(findOperation("blob.show")?.response, undefined);
  });

  it("exactly two registry entries carry a response and none carries a request", () => {
    const withResponse = registry.filter(
      (entry) => entry.response !== undefined,
    );
    assert.equal(withResponse.length, 2);
    assert.deepEqual(withResponse.map((entry) => entry.operationId).sort(), [
      "system.db",
      "system.health",
    ]);
    assert.equal(
      registry.filter((entry) => entry.request !== undefined).length,
      0,
    );
  });

  it("no request schema names a server path", () => {
    const requestNames = propertyNamesOf(registry, "input");
    for (const banned of bannedPropertyNames) {
      assert.equal(requestNames.has(banned), false, `banned ${banned}`);
    }
  });

  it("no response schema names a server path", () => {
    const responseNames = propertyNamesOf(registry, "output");
    for (const banned of bannedPropertyNames) {
      assert.equal(responseNames.has(banned), false, `banned ${banned}`);
    }
  });

  it("plan.import carries no request schema today", () => {
    assert.equal(findOperation("plan.import")?.request, undefined);
  });
});
