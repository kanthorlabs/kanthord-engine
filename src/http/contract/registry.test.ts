import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { action, hash, parameter, resource, sub, system } from "./path.ts";
import type { Segment } from "./path.ts";
import {
  findOperation,
  matchRoute,
  registry,
  registryFaults,
} from "./registry.ts";

describe("src/http/contract/registry.test", () => {
  it("registers fifty-three operations", () => {
    assert.equal(registry.length, 53);
  });

  it("sorts the registry bytewise by operationId with no duplicates", () => {
    const ids = registry.map((entry) => entry.operationId);
    assert.equal(new Set(ids).size, 53);
    for (let i = 0; i < ids.length - 1; i += 1) {
      assert.ok(
        Buffer.compare(Buffer.from(ids[i]!), Buffer.from(ids[i + 1]!)) < 0,
        `${ids[i]} sorts before ${ids[i + 1]}`,
      );
    }
  });

  it("counts routed and stubbed entries", () => {
    assert.equal(
      registry.filter((entry) => entry.status === "routed").length,
      23,
    );
    assert.equal(
      registry.filter((entry) => entry.status === "stubbed").length,
      30,
    );
  });

  it("counts introducedIn values with no post-mvp row", () => {
    assert.equal(
      registry.filter((entry) => entry.introducedIn === "phase-1").length,
      23,
    );
    assert.equal(
      registry.filter((entry) => entry.introducedIn === "phase-2").length,
      27,
    );
    assert.equal(
      registry.filter((entry) => entry.introducedIn === "phase-3").length,
      3,
    );
    assert.equal(
      registry.filter((entry) => entry.introducedIn === "post-mvp").length,
      0,
    );
  });

  it("admits no deferred entry at runtime", () => {
    assert.equal(
      registry.filter((entry) => (entry.status as string) === "deferred")
        .length,
      0,
    );
  });

  it("registers none of the four deferred rows", () => {
    for (const operationId of [
      "binding.provider.project",
      "binding.e2e.project",
      "binding.provider.agent",
      "event.stream",
    ]) {
      assert.equal(findOperation(operationId), undefined);
    }
  });

  it("attaches requests to the seven write routes and responses to the twenty-one routes", () => {
    const withRequest = registry.filter((entry) => entry.request !== undefined);
    assert.deepEqual(withRequest.map((entry) => entry.operationId).sort(), [
      "plan.import",
      "plan.validate",
      "project.create",
      "project.repositories",
      "provider.register",
      "repository.inspect",
      "repository.register",
    ]);
    const withResponse = registry.filter(
      (entry) => entry.response !== undefined,
    );
    assert.deepEqual(withResponse.map((entry) => entry.operationId).sort(), [
      "edge.list",
      "node.list",
      "node.show",
      "plan.export",
      "plan.import",
      "plan.revisions",
      "plan.validate",
      "project.create",
      "project.list",
      "project.repositories",
      "project.show",
      "provider.list",
      "provider.register",
      "provider.show",
      "repository.inspect",
      "repository.list",
      "repository.register",
      "repository.show",
      "system.db",
      "system.health",
      "system.status",
    ]);
  });

  it("reports no faults on the authored registry", () => {
    assert.deepEqual(registryFaults(registry), []);
  });

  it("keeps the hash parameter exclusive to blob.show", () => {
    const hashed = registry.filter((entry) =>
      entry.path.some(
        (segment) => segment.kind === "parameter" && segment.value === "hash",
      ),
    );
    assert.equal(hashed.length, 1);
    assert.equal(hashed[0]?.operationId, "blob.show");
  });

  it("keeps the deferred identity exclusive to template.show", () => {
    const deferred = registry.filter((entry) =>
      entry.path.some(
        (segment) =>
          segment.kind === "parameter" &&
          segment.value === "id" &&
          segment.identity === "deferred",
      ),
    );
    assert.equal(deferred.length, 1);
    assert.equal(deferred[0]?.operationId, "template.show");
  });

  it("matches the one-segment system path", () => {
    const match = matchRoute("GET", "/v1/health");
    assert.equal(match?.operation.operationId, "system.health");
    assert.deepEqual(match?.parameters, {});
  });

  it("does not let a two-segment system path shadow a one-segment one", () => {
    assert.equal(
      matchRoute("GET", "/v1/db/status")?.operation.operationId,
      "system.db",
    );
    assert.equal(
      matchRoute("GET", "/v1/status")?.operation.operationId,
      "system.status",
    );
  });

  it("binds a parameter to the raw segment", () => {
    const match = matchRoute("POST", "/v1/node/task_01JQ8ZAN9P/unblock");
    assert.equal(match?.operation.operationId, "node.unblock");
    assert.deepEqual(match?.parameters, { id: "task_01JQ8ZAN9P" });
  });

  it("keeps a colon inside a hash segment intact", () => {
    const match = matchRoute("GET", "/v1/blob/sha256:9f2a");
    assert.equal(match?.operation.operationId, "blob.show");
    assert.deepEqual(match?.parameters, { hash: "sha256:9f2a" });
  });

  it("prefers the literal action over a parameter match", () => {
    assert.equal(
      matchRoute("POST", "/v1/repository/inspect")?.operation.operationId,
      "repository.inspect",
    );
  });

  it("drops a trailing slash", () => {
    assert.equal(
      matchRoute("GET", "/v1/node/")?.operation.operationId,
      "node.list",
    );
  });

  it("refuses a path or method that matches nothing", () => {
    for (const [method, pathname] of [
      ["GET", "/v1/nope"],
      ["PATCH", "/v1/health"],
      ["GET", "/health"],
      ["GET", "/v2/health"],
      ["GET", "/v1/health/extra"],
      ["GET", "/v1/node//unblock"],
      ["PUT", "/v1/agent/re@1/binding/provider"],
    ] as const) {
      assert.equal(matchRoute(method, pathname), null, `${method} ${pathname}`);
    }
  });

  it("matches every entry over its own concrete path", () => {
    for (const entry of registry) {
      const concrete = entry.path
        .map((segment) =>
          segment.kind === "parameter" ? "x_01" : segment.value,
        )
        .join("/");
      assert.equal(
        matchRoute(entry.method, `/v1/${concrete}`)?.operation.operationId,
        entry.operationId,
      );
    }
  });

  it("flags a duplicate operationId", () => {
    const faults = registryFaults([
      {
        operationId: "dup.op",
        method: "GET",
        path: [system("health")],
        introducedIn: "phase-1",
        status: "routed",
      },
      {
        operationId: "dup.op",
        method: "GET",
        path: [system("status")],
        introducedIn: "phase-1",
        status: "routed",
      },
    ]);
    assert.deepEqual(
      faults.map((fault) => fault.reason),
      ["duplicate operationId"],
    );
  });

  it("flags a method and path collision", () => {
    const faults = registryFaults([
      {
        operationId: "a.one",
        method: "GET",
        path: [system("health")],
        introducedIn: "phase-1",
        status: "routed",
      },
      {
        operationId: "a.two",
        method: "GET",
        path: [system("health")],
        introducedIn: "phase-1",
        status: "routed",
      },
    ]);
    assert.ok(
      faults.some((fault) => fault.reason === "method and path collide"),
    );
  });

  it("flags an ambiguous path", () => {
    const faults = registryFaults([
      {
        operationId: "n.show",
        method: "GET",
        path: [resource("node"), parameter("node")],
        introducedIn: "phase-1",
        status: "routed",
      },
      {
        operationId: "n.runs",
        method: "GET",
        path: [resource("node"), sub("run")],
        introducedIn: "phase-2",
        status: "stubbed",
      },
    ]);
    assert.ok(faults.some((fault) => fault.reason === "path is ambiguous"));
  });

  it("flags a segment invalid in its declared kind and a plural", () => {
    const plural = {
      kind: "resource",
      value: "repositories",
    } as unknown as Segment;
    const faults = registryFaults([
      {
        operationId: "x.plural",
        method: "GET",
        path: [plural],
        introducedIn: "phase-1",
        status: "routed",
      },
    ]);
    assert.ok(
      faults.some(
        (fault) => fault.reason === "segment is invalid in its declared kind",
      ),
    );
    assert.ok(
      faults.some((fault) => fault.reason === "resource segment is plural"),
    );
  });

  it("flags a non-minted locator outside blob", () => {
    const faults = registryFaults([
      {
        operationId: "e.byHash",
        method: "GET",
        path: [resource("event"), hash()],
        introducedIn: "phase-1",
        status: "routed",
      },
    ]);
    assert.ok(
      faults.some(
        (fault) => fault.reason === "non-minted locator outside blob",
      ),
    );
  });

  it("flags a deferred identity outside template.show", () => {
    const faults = registryFaults([
      {
        operationId: "node.show",
        method: "GET",
        path: [resource("node"), parameter("deferred")],
        introducedIn: "phase-1",
        status: "routed",
      },
    ]);
    assert.ok(
      faults.some(
        (fault) => fault.reason === "deferred identity outside template.show",
      ),
    );
  });

  it("rejects a resource path that repeats the resource", () => {
    const faults = registryFaults([
      {
        operationId: "x.dup",
        method: "GET",
        path: [resource("project"), parameter("project"), resource("project")],
        introducedIn: "phase-1",
        status: "routed",
      },
    ]);
    assert.ok(
      faults.some(
        (fault) => fault.reason === "segment sequence is not a legal path",
      ),
    );
  });

  it("rejects a system path that repeats the leaf", () => {
    const faults = registryFaults([
      {
        operationId: "x.dup",
        method: "GET",
        path: [system("status"), system("status")],
        introducedIn: "phase-1",
        status: "routed",
      },
    ]);
    assert.ok(
      faults.some(
        (fault) => fault.reason === "segment sequence is not a legal path",
      ),
    );
  });

  it("rejects every illegal kind sequence", () => {
    const sequences: ReadonlyArray<readonly Segment[]> = [
      [action("import")],
      [parameter("node")],
      [resource("node"), action("unblock"), action("abandon")],
      [resource("node"), parameter("node"), parameter("node")],
      [system("health"), resource("node")],
      [system("db")],
      [resource("node"), sub("run"), parameter("run")],
      [],
    ];
    for (const path of sequences) {
      const faults = registryFaults([
        {
          operationId: "x.bad",
          method: "GET",
          path,
          introducedIn: "phase-1",
          status: "routed",
        },
      ]);
      assert.ok(
        faults.some(
          (fault) => fault.reason === "segment sequence is not a legal path",
        ),
        `expected a grammar fault for ${path.map((segment) => segment.kind).join(",")}`,
      );
    }
  });

  it("accepts an action on a collection", () => {
    assert.deepEqual(
      registryFaults([
        {
          operationId: "repository.inspect",
          method: "POST",
          path: [resource("repository"), action("inspect")],
          introducedIn: "phase-1",
          status: "routed",
        },
      ]),
      [],
    );
  });

  it("accepts every distinct kind shape on its own", () => {
    const shapes = new Set(
      registry.map((entry) =>
        entry.path.map((segment) => segment.kind).join(","),
      ),
    );
    assert.ok(shapes.size > 1, "the registry has more than one path shape");
    assert.ok(
      shapes.size < registry.length,
      "the kind sequences reduce to a distinct set",
    );
    for (const entry of registry) {
      assert.deepEqual(registryFaults([entry]), []);
    }
  });
});
