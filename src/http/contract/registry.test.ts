import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  action,
  hash,
  parameter,
  renderPath,
  resource,
  sub,
  system,
} from "./path.ts";
import type { Segment } from "./path.ts";
import { idempotencyOf, idempotencyPolicies } from "./operation.ts";
import type { Operation } from "./operation.ts";
import {
  findOperation,
  matchRoute,
  registry,
  registryFaults,
} from "./registry.ts";
import { registeredActorKinds } from "../../domain/actor.ts";

const bytewise = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

export const harnessOperations = [
  "blob.show",
  "edge.list",
  "node.claim",
  "node.create",
  "node.delete",
  "node.list",
  "node.release",
  "node.renew",
  "node.report",
  "node.show",
  "node.update",
  "plan.export",
  "plan.revisions",
  "project.list",
  "project.nodes",
  "project.show",
  "project.status",
  "system.health",
];

describe("src/http/contract/registry.test", () => {
  it("registers seventy-three operations", () => {
    assert.equal(registry.length, 73);
  });

  it("sorts the registry bytewise by operationId with no duplicates", () => {
    const ids = registry.map((entry) => entry.operationId);
    assert.equal(new Set(ids).size, 73);
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
      50,
    );
    assert.equal(
      registry.filter((entry) => entry.status === "stubbed").length,
      23,
    );
  });

  it("counts introducedIn values with no post-mvp row", () => {
    assert.equal(
      registry.filter((entry) => entry.introducedIn === "phase-1").length,
      40,
    );
    assert.equal(
      registry.filter((entry) => entry.introducedIn === "phase-2").length,
      30,
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
      "binding.provider.agents",
      "event.stream",
    ]) {
      assert.equal(findOperation(operationId), undefined);
    }
  });

  it("attaches requests to the twenty write routes and responses to the forty-eight routes", () => {
    const withRequest = registry.filter((entry) => entry.request !== undefined);
    assert.deepEqual(withRequest.map((entry) => entry.operationId).sort(), [
      "actor.register",
      "node.claim",
      "node.create",
      "node.delete",
      "node.release",
      "node.renew",
      "node.report",
      "node.update",
      "plan.import",
      "plan.validate",
      "project.create",
      "project.repositories",
      "provider.inspect",
      "provider.loginCancel",
      "provider.loginComplete",
      "provider.loginStart",
      "provider.register",
      "provider.rename",
      "repository.inspect",
      "repository.register",
    ]);
    const withResponse = registry.filter(
      (entry) => entry.response !== undefined,
    );
    assert.deepEqual(withResponse.map((entry) => entry.operationId).sort(), [
      "actor.list",
      "actor.register",
      "actor.revoke",
      "actor.rotate",
      "actor.show",
      "agent.list",
      "edge.list",
      "event.list",
      "node.claim",
      "node.create",
      "node.delete",
      "node.list",
      "node.release",
      "node.renew",
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
      "provider.loginComplete",
      "provider.loginStart",
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
      "worker.list",
    ]);
  });

  it("reports no faults on the authored registry", () => {
    assert.deepEqual(registryFaults(registry), []);
  });

  it("event.list, node.list, provider.catalog and provider.remove are the only operations with a query schema", () => {
    assert.deepEqual(
      registry
        .filter((entry) => entry.query !== undefined)
        .map((entry) => entry.operationId),
      ["event.list", "node.list", "provider.catalog", "provider.remove"],
    );
  });

  it("flags a query schema on a stubbed operation", () => {
    const faults = registryFaults([
      {
        operationId: "x.stub",
        method: "GET",
        path: [system("health")],
        introducedIn: "phase-1",
        status: "stubbed",
        allowedActors: ["human"],
        query: registry.find((entry) => entry.operationId === "event.list")
          ?.query,
      },
    ]);
    assert.deepEqual(
      faults.map((fault) => fault.reason),
      ["query-on-stubbed"],
    );
  });

  it("flags an entry declaring both response and responseMedia", () => {
    const faults = registryFaults([
      {
        operationId: "x.both",
        method: "GET",
        path: [system("health")],
        introducedIn: "phase-1",
        status: "routed",
        allowedActors: ["human"],
        response: registry.find((entry) => entry.operationId === "node.list")
          ?.response,
        responseMedia: "application/octet-stream",
      },
    ]);
    assert.deepEqual(
      faults.map((fault) => fault.reason),
      ["response and responseMedia both declared"],
    );
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

  it("resolves GET /v1/provider/llm to the catalog, not to provider.show", () => {
    assert.equal(
      matchRoute("GET", "/v1/provider/llm")?.operation.operationId,
      "provider.catalog",
    );
  });

  it("still resolves a provider id on the same GET shape", () => {
    const id = "provider_01HZY8QF3M4N5P6R7S8T9V0W1X";
    const match = matchRoute("GET", `/v1/provider/${id}`);
    assert.equal(match?.operation.operationId, "provider.show");
    assert.equal(match?.parameters.id, id);
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
        allowedActors: ["human"],
      },
      {
        operationId: "dup.op",
        method: "GET",
        path: [system("status")],
        introducedIn: "phase-1",
        status: "routed",
        allowedActors: ["human"],
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
        allowedActors: ["human"],
      },
      {
        operationId: "a.two",
        method: "GET",
        path: [system("health")],
        introducedIn: "phase-1",
        status: "routed",
        allowedActors: ["human"],
      },
    ]);
    assert.ok(
      faults.some((fault) => fault.reason === "method and path collide"),
    );
  });

  it("flags two paths that carry a parameter in the same position", () => {
    const faults = registryFaults([
      {
        operationId: "n.show",
        method: "GET",
        path: [resource("node"), parameter("node")],
        introducedIn: "phase-1",
        status: "routed",
        allowedActors: ["human"],
      },
      {
        operationId: "n.other",
        method: "GET",
        path: [resource("node"), parameter("deferred")],
        introducedIn: "phase-2",
        status: "stubbed",
        allowedActors: ["human"],
      },
    ]);
    assert.ok(faults.some((fault) => fault.reason === "path is ambiguous"));
  });

  it("admits a literal beside a parameter, because matchRoute prefers the literal", () => {
    const entries = [
      {
        operationId: "n.show",
        method: "GET",
        path: [resource("node"), parameter("node")],
        introducedIn: "phase-1",
        status: "routed",
        allowedActors: ["human"],
      },
      {
        operationId: "n.runs",
        method: "GET",
        path: [resource("node"), sub("run")],
        introducedIn: "phase-2",
        status: "stubbed",
        allowedActors: ["human"],
      },
    ] as const;

    const faults = registryFaults([...entries]);

    assert.equal(
      faults.some((fault) => fault.reason === "path is ambiguous"),
      false,
    );
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
        allowedActors: ["human"],
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
        allowedActors: ["human"],
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
        allowedActors: ["human"],
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
        allowedActors: ["human"],
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
        allowedActors: ["human"],
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
          allowedActors: ["human"],
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

  it("refuses a parameter after the login subresource", () => {
    const entry = {
      operationId: "provider.loginIllegal",
      method: "POST",
      path: [resource("provider"), sub("login"), parameter("provider")],
      introducedIn: "phase-2",
      status: "routed",
      allowedActors: ["human"],
    } as const;
    const faults = registryFaults([entry]);
    assert.equal(faults.length, 1);
    assert.equal(faults[0]?.reason, "segment sequence is not a legal path");
  });

  it("accepts the three login tuples", () => {
    for (const path of [
      [resource("provider"), sub("login")],
      [resource("provider"), sub("login"), action("complete")],
      [resource("provider"), sub("login"), action("cancel")],
    ] as const) {
      assert.deepEqual(
        registryFaults([
          {
            operationId: "provider.loginProbe",
            method: "POST",
            path,
            introducedIn: "phase-2",
            status: "routed",
            allowedActors: ["human"],
          },
        ]),
        [],
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
          allowedActors: ["human"],
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

  it("pins the idempotency policy set", () => {
    assert.deepEqual(idempotencyPolicies, ["none", "memory", "durable"]);
  });

  it("defaults idempotencyOf to none", () => {
    const entry: Operation = {
      operationId: "g.one",
      method: "GET",
      path: [system("health")],
      introducedIn: "phase-1",
      status: "routed",
      allowedActors: ["human"],
    };
    assert.equal(idempotencyOf(entry), "none");
  });

  it("declares a policy on every POST and only a POST", () => {
    for (const entry of registry) {
      assert.equal(
        idempotencyOf(entry) !== "none",
        entry.method === "POST",
        entry.operationId,
      );
    }
  });

  it("declares exactly the thirty-three POST policies the story names", () => {
    const keyed = registry
      .filter((entry) => idempotencyOf(entry) !== "none")
      .map((entry) => entry.operationId)
      .sort(bytewise);
    assert.deepEqual(
      keyed,
      [
        "actor.register",
        "actor.revoke",
        "actor.rotate",
        "node.claim",
        "node.create",
        "node.delete",
        "node.renew",
        "node.release",
        "node.report",
        "node.update",
        "plan.import",
        "plan.validate",
        "project.create",
        "provider.inspect",
        "provider.loginCancel",
        "provider.loginComplete",
        "provider.loginStart",
        "provider.register",
        "provider.rename",
        "provider.verify",
        "repository.inspect",
        "repository.register",
        "repository.publish",
        "repository.reconcile",
        "run.start",
        "run.cancel",
        "node.approve",
        "node.discard",
        "node.waive",
        "node.unblock",
        "node.abandon",
        "profile.instantiate",
        "profile.verify",
      ].sort(bytewise),
    );
  });

  it("reserves durable for plan.import alone", () => {
    assert.deepEqual(
      registry
        .filter((entry) => idempotencyOf(entry) === "durable")
        .map((entry) => entry.operationId),
      ["plan.import"],
    );
  });

  it("counts thirty-two memory-policy operations", () => {
    assert.equal(
      registry.filter((entry) => idempotencyOf(entry) === "memory").length,
      32,
    );
  });

  it("keeps the authored registry fault-free with the policy declared", () => {
    assert.deepEqual(registryFaults(registry), []);
  });

  it("flags a GET declaring memory", () => {
    const faults = registryFaults([
      {
        operationId: "g.one",
        method: "GET",
        path: [system("health")],
        introducedIn: "phase-1",
        status: "routed",
        allowedActors: ["human"],
        idempotency: "memory",
        replayable: [200],
      },
    ]);
    assert.deepEqual(
      faults.map((fault) => fault.reason),
      ["idempotency policy outside POST"],
    );
  });

  it("does not flag a GET declaring none explicitly", () => {
    const faults = registryFaults([
      {
        operationId: "g.one",
        method: "GET",
        path: [system("health")],
        introducedIn: "phase-1",
        status: "routed",
        allowedActors: ["human"],
        idempotency: "none",
      },
    ]);
    assert.deepEqual(faults, []);
  });

  it("flags a PUT declaring durable in emission order", () => {
    const faults = registryFaults([
      {
        operationId: "p.one",
        method: "PUT",
        path: [resource("project"), parameter("project")],
        introducedIn: "phase-1",
        status: "routed",
        allowedActors: ["human"],
        idempotency: "durable",
      },
    ]);
    assert.deepEqual(
      faults.map((fault) => fault.reason),
      [
        "idempotency policy outside POST",
        "durable idempotency outside plan.import",
      ],
    );
  });

  it("flags durable declared on a POST other than plan.import", () => {
    const faults = registryFaults([
      {
        operationId: "project.create",
        method: "POST",
        path: [resource("project")],
        introducedIn: "phase-1",
        status: "routed",
        allowedActors: ["human"],
        idempotency: "durable",
      },
    ]);
    assert.deepEqual(
      faults.map((fault) => fault.reason),
      ["durable idempotency outside plan.import"],
    );
  });

  it("keeps the authored registry fault-free with replayable declared", () => {
    assert.deepEqual(registryFaults(registry), []);
  });

  it("declares [200] on every memory entry except login cancel", () => {
    for (const entry of registry) {
      if (idempotencyOf(entry) === "memory") {
        assert.deepEqual(
          entry.replayable,
          entry.operationId === "provider.loginCancel" ? [204] : [200],
          entry.operationId,
        );
      }
    }
  });

  it("declares no replayable outcome on plan.import", () => {
    assert.equal(findOperation("plan.import")?.replayable, undefined);
  });

  it("declares replayable only on a memory entry", () => {
    for (const entry of registry) {
      assert.equal(
        entry.replayable !== undefined,
        idempotencyOf(entry) === "memory",
        entry.operationId,
      );
    }
  });

  it("node.claim, node.renew and node.release each declare memory idempotency and replayable [200]", () => {
    for (const operationId of ["node.claim", "node.renew", "node.release"]) {
      const entry = findOperation(operationId);
      assert.notEqual(entry, undefined, operationId);
      assert.equal(idempotencyOf(entry!), "memory", operationId);
      assert.deepEqual(entry!.replayable, [200], operationId);
    }
  });

  it("each of the three admits human and harness", () => {
    for (const operationId of ["node.claim", "node.renew", "node.release"]) {
      assert.deepEqual(
        findOperation(operationId)?.allowedActors,
        ["human", "harness"],
        operationId,
      );
    }
  });

  it("the three worker paths render as expected", () => {
    const claim = findOperation("node.claim");
    const renew = findOperation("node.renew");
    const release = findOperation("node.release");
    assert.equal(renderPath(claim!.path), "/v1/node/:id/claim");
    assert.equal(renderPath(renew!.path), "/v1/node/:id/renew");
    assert.equal(renderPath(release!.path), "/v1/node/:id/release");
  });

  it("node.report declares its lifecycle by operation id", () => {
    const entry = findOperation("node.report");
    assert.notEqual(entry, undefined);
    assert.deepEqual(entry!.allowedActors, ["human", "harness"]);
    assert.equal(idempotencyOf(entry!), "memory");
    assert.deepEqual(entry!.replayable, [200]);
    assert.equal(entry!.introducedIn, "phase-1");
    assert.equal(entry!.status, "routed");
    assert.deepEqual(registryFaults(registry), []);
  });

  it("node.heartbeat is absent from the registry", () => {
    assert.equal(findOperation("node.heartbeat"), undefined);
  });

  it("node.renew is routed", () => {
    const entry = findOperation("node.renew");
    assert.notEqual(entry, undefined);
    assert.equal(entry!.status, "routed");
    assert.equal(renderPath(entry!.path), "/v1/node/:id/renew");
  });

  it("flags a replayable outcome declared without a memory policy", () => {
    const faults = registryFaults([
      {
        operationId: "g.one",
        method: "GET",
        path: [system("health")],
        introducedIn: "phase-1",
        status: "routed",
        allowedActors: ["human"],
        replayable: [200],
      },
    ]);
    assert.deepEqual(
      faults.map((fault) => fault.reason),
      ["replayable outcome without a memory policy"],
    );
  });

  it("flags a memory policy with no replayable outcome", () => {
    const faults = registryFaults([
      {
        operationId: "p.one",
        method: "POST",
        path: [resource("project")],
        introducedIn: "phase-1",
        status: "routed",
        allowedActors: ["human"],
        idempotency: "memory",
      },
    ]);
    assert.deepEqual(
      faults.map((fault) => fault.reason),
      ["memory idempotency without a replayable outcome"],
    );
  });

  it("flags a memory policy with an empty replayable list", () => {
    const faults = registryFaults([
      {
        operationId: "p.one",
        method: "POST",
        path: [resource("project")],
        introducedIn: "phase-1",
        status: "routed",
        allowedActors: ["human"],
        idempotency: "memory",
        replayable: [],
      },
    ]);
    assert.deepEqual(
      faults.map((fault) => fault.reason),
      ["memory idempotency without a replayable outcome"],
    );
  });

  it("flags a malformed replayable status list", () => {
    const malformed: readonly (readonly number[])[] = [
      [200.5],
      [0],
      [99],
      [600],
      [200, 200],
    ];
    for (const replayable of malformed) {
      const faults = registryFaults([
        {
          operationId: "p.one",
          method: "POST",
          path: [resource("project")],
          introducedIn: "phase-1",
          status: "routed",
          allowedActors: ["human"],
          idempotency: "memory",
          replayable,
        },
      ]);
      assert.deepEqual(
        faults.map((fault) => fault.reason),
        ["replayable outcome is not a distinct status list"],
        JSON.stringify(replayable),
      );
    }
  });

  it("flags both faults for a malformed list on a none entry", () => {
    const faults = registryFaults([
      {
        operationId: "g.one",
        method: "GET",
        path: [system("health")],
        introducedIn: "phase-1",
        status: "routed",
        allowedActors: ["human"],
        replayable: [200, 200],
      },
    ]);
    assert.deepEqual(
      faults.map((fault) => fault.reason),
      [
        "replayable outcome without a memory policy",
        "replayable outcome is not a distinct status list",
      ],
    );
  });

  it("flags a durable entry declaring a replayable outcome", () => {
    const faults = registryFaults([
      {
        operationId: "plan.import",
        method: "POST",
        path: [
          resource("project"),
          parameter("project"),
          sub("plan"),
          action("import"),
        ],
        introducedIn: "phase-1",
        status: "routed",
        allowedActors: ["human"],
        idempotency: "durable",
        replayable: [200],
      },
    ]);
    assert.deepEqual(
      faults.map((fault) => fault.reason),
      ["replayable outcome without a memory policy"],
    );
  });

  describe("allowedActors", () => {
    it("declares a non-empty allowedActors on every entry", () => {
      for (const entry of registry) {
        assert.ok(
          entry.allowedActors.length > 0,
          `${entry.operationId} declares no allowed actor`,
        );
      }
    });

    it("admits the human kind on every entry", () => {
      for (const entry of registry) {
        assert.ok(
          entry.allowedActors.includes("human"),
          `${entry.operationId} does not admit human`,
        );
      }
    });

    it("admits only registered actor kinds", () => {
      for (const entry of registry) {
        for (const kind of entry.allowedActors) {
          assert.ok(
            registeredActorKinds.includes(kind),
            `${entry.operationId} admits the unregistered kind ${kind}`,
          );
        }
      }
    });

    it("the harness set equals the named list by bytewise order", () => {
      const actual = registry
        .filter((entry) => entry.allowedActors.includes("harness"))
        .map((entry) => entry.operationId)
        .sort(bytewise);
      assert.deepEqual(actual, harnessOperations);
    });

    it("the harness set names the seven node operations of EPIC 017 018 and 022 adds project.nodes", () => {
      for (const operationId of [
        "node.claim",
        "node.create",
        "node.delete",
        "node.renew",
        "node.release",
        "node.update",
        "project.nodes",
      ]) {
        assert.ok(
          harnessOperations.includes(operationId),
          `${operationId} is missing from the harness set`,
        );
      }
    });

    it("node.report joins the harness set and actor.register stays human alone", () => {
      assert.ok(harnessOperations.includes("node.report"));
      assert.deepEqual(findOperation("actor.register")?.allowedActors, [
        "human",
      ]);
    });

    it("every operation outside the harness set admits human alone", () => {
      const set = new Set(harnessOperations);
      for (const entry of registry) {
        if (!set.has(entry.operationId)) {
          assert.deepEqual(entry.allowedActors, ["human"], entry.operationId);
        }
      }
    });

    it("excludes system.status and event.list from the harness set by name", () => {
      assert.ok(!harnessOperations.includes("system.status"));
      assert.ok(!harnessOperations.includes("event.list"));
    });
  });
});
