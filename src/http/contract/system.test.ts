import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  systemDbResponse,
  systemHealthResponse,
  systemStatusResponse,
} from "./system.ts";
import { dependencyStatuses } from "../../domain/health.ts";
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

const planRelativePathLocations = [
  "documents.path",
  "findings.path",
  "completeness.path",
  "choices.path",
];

function collectPropertyNames(
  schema: unknown,
  parent: string,
  into: Set<string>,
): void {
  if (typeof schema !== "object" || schema === null) {
    return;
  }
  const record = schema as Readonly<Record<string, unknown>>;
  const properties = record.properties;
  if (typeof properties === "object" && properties !== null) {
    for (const [key, child] of Object.entries(
      properties as Readonly<Record<string, unknown>>,
    )) {
      into.add(`${parent}.${key}`);
      collectPropertyNames(child, key, into);
    }
  }
  if (record.items !== undefined) {
    collectPropertyNames(record.items, parent, into);
  }
}

const propertyNamesOf = (
  entries: readonly Operation[],
  io: "input" | "output",
): Set<string> => {
  const located = new Set<string>();
  for (const entry of entries) {
    const schema = io === "input" ? entry.request : entry.response;
    if (schema === undefined) {
      continue;
    }
    collectPropertyNames(
      z.toJSONSchema(schema, { target: "openapi-3.0", io }),
      "",
      located,
    );
  }
  const names = new Set<string>();
  for (const location of located) {
    if (planRelativePathLocations.includes(location)) {
      continue;
    }
    names.add(location.slice(location.lastIndexOf(".") + 1));
  }
  return names;
};

describe("src/http/contract/system.test", () => {
  it("systemHealthResponse accepts an empty and a two-line dependency list", () => {
    assert.equal(
      systemHealthResponse.safeParse({
        status: "ok",
        version: "27.8.1",
        capabilities: [],
        dependencies: [],
      }).success,
      true,
    );
    assert.equal(
      systemHealthResponse.safeParse({
        status: "degraded",
        version: "27.8.1",
        capabilities: ["external-drive", "per-node-write"],
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
      { status: "ok", version: "27.8.1", dependencies: [] },
      { status: "ok", capabilities: [], dependencies: [] },
      {
        status: "up",
        version: "27.8.1",
        capabilities: [],
        dependencies: [],
      },
      {
        status: "ok",
        version: "27.8.1",
        capabilities: [],
        dependencies: [],
        extra: 1,
      },
      {
        status: "ok",
        version: "27.8.1",
        capabilities: ["not-a-capability"],
        dependencies: [],
      },
      {
        status: "ok",
        version: "27.8.1",
        capabilities: [],
        dependencies: [{ name: "", status: "ok" }],
      },
      {
        status: "ok",
        version: "27.8.1",
        capabilities: [],
        dependencies: [{ name: "storage", status: "fine" }],
      },
      {
        status: "ok",
        version: "27.8.1",
        capabilities: [],
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

  it("binds systemHealthResponse to system.health, systemDbResponse to system.db and systemStatusResponse to system.status", () => {
    assert.strictEqual(
      findOperation("system.health")?.response,
      systemHealthResponse,
    );
    assert.strictEqual(findOperation("system.db")?.response, systemDbResponse);
    assert.strictEqual(
      findOperation("system.status")?.response,
      systemStatusResponse,
    );
  });

  it("system.health, system.db and system.status carry no request schema", () => {
    assert.equal(findOperation("system.health")?.request, undefined);
    assert.equal(findOperation("system.db")?.request, undefined);
    assert.equal(findOperation("system.status")?.request, undefined);
  });

  it("blob.show carries no response schema", () => {
    assert.equal(findOperation("blob.show")?.response, undefined);
  });

  it("blob.show declares application/octet-stream as its response media", () => {
    assert.equal(
      findOperation("blob.show")?.responseMedia,
      "application/octet-stream",
    );
  });

  it("no operation but blob.show declares a response media", () => {
    const withMedia = registry
      .filter((entry) => entry.responseMedia !== undefined)
      .map((entry) => entry.operationId);
    assert.deepEqual(withMedia, ["blob.show"]);
  });

  it("systemStatusResponse accepts a minimal and a full shape", () => {
    const minimal = {
      version: "27.8.1",
      bind: "127.0.0.1:7421",
      startedAt: "2026-08-06T00:00:00.000Z",
      status: "ok",
      dependencies: [],
      nodes: [],
      repositories: [],
      leases: [],
    };
    assert.equal(systemStatusResponse.safeParse(minimal).success, true);
    assert.equal(
      systemStatusResponse.safeParse({
        ...minimal,
        status: "degraded",
        dependencies: [{ name: "storage", status: "failed" }],
        nodes: [
          {
            kind: "task",
            state: "blocked",
            blockReason: "stale-base",
            count: 1,
          },
        ],
        repositories: [
          {
            id: "repo_a",
            name: "kanthord-verify",
            divergedLandingOid: "a".repeat(40),
            divergedUpstreamOid: "b".repeat(40),
          },
        ],
        leases: [
          {
            subjectKind: "node",
            subjectId: "task_a",
            owner: null,
            fence: 1,
            expiresAt: 1700000000,
          },
        ],
      }).success,
      true,
    );
  });

  it("systemStatusResponse rejects every non-contract shape", () => {
    const base = {
      version: "27.8.1",
      bind: "127.0.0.1:7421",
      startedAt: "2026-08-06T00:00:00.000Z",
      status: "ok",
      dependencies: [],
      nodes: [],
      repositories: [],
      leases: [],
    };
    const rejected = [
      { ...base, extra: 1 },
      { ...base, status: "up" },
      { ...base, startedAt: "" },
      { ...base, dependencies: [{ name: "storage", status: "fine" }] },
      {
        ...base,
        nodes: [{ kind: "task", state: "blocked", count: 1 }],
      },
      {
        ...base,
        nodes: [
          {
            kind: "widget",
            state: "blocked",
            blockReason: null,
            count: 1,
          },
        ],
      },
      {
        ...base,
        nodes: [
          {
            kind: "task",
            state: "blocked",
            blockReason: null,
            count: 0,
          },
        ],
      },
      {
        ...base,
        leases: [
          {
            subjectKind: "widget",
            subjectId: "task_a",
            owner: null,
            fence: 1,
            expiresAt: 1700000000,
          },
        ],
      },
    ];
    for (const value of rejected) {
      assert.equal(
        systemStatusResponse.safeParse(value).success,
        false,
        `accepted ${JSON.stringify(value)}`,
      );
    }
  });

  it("forty-four registry entries carry a response and seventeen carry a request", () => {
    const withResponse = registry.filter(
      (entry) => entry.response !== undefined,
    );
    assert.equal(withResponse.length, 44);
    assert.deepEqual(withResponse.map((entry) => entry.operationId).sort(), [
      "actor.list",
      "actor.register",
      "actor.revoke",
      "actor.rotate",
      "actor.show",
      "edge.list",
      "event.list",
      "node.claim",
      "node.create",
      "node.delete",
      "node.heartbeat",
      "node.list",
      "node.release",
      "node.report",
      "node.show",
      "node.unblock",
      "node.update",
      "plan.export",
      "plan.import",
      "plan.revisions",
      "plan.validate",
      "project.create",
      "project.graph",
      "project.list",
      "project.nodes",
      "project.repositories",
      "project.show",
      "project.status",
      "provider.catalog",
      "provider.inspect",
      "provider.list",
      "provider.register",
      "provider.remove",
      "provider.rename",
      "provider.setDefault",
      "provider.show",
      "provider.verify",
      "repository.inspect",
      "repository.list",
      "repository.register",
      "repository.show",
      "system.db",
      "system.health",
      "system.status",
    ]);
    assert.deepEqual(
      registry
        .filter((entry) => entry.request !== undefined)
        .map((entry) => entry.operationId)
        .sort(),
      [
        "actor.register",
        "node.claim",
        "node.create",
        "node.delete",
        "node.heartbeat",
        "node.release",
        "node.report",
        "node.update",
        "plan.import",
        "plan.validate",
        "project.create",
        "project.repositories",
        "provider.inspect",
        "provider.register",
        "provider.rename",
        "repository.inspect",
        "repository.register",
      ],
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
});
