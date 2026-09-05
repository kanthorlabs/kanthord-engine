import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import { nodeClaimResponse, nodeRenewResponse } from "./execution.ts";
import { buildErrorEnvelope } from "./errors.ts";
import { fieldDecisions } from "./field-decisions.fixture.ts";
import { nodeReportRequest } from "./outcome.ts";
import { findOperation, registry } from "./registry.ts";

const withExamples = registry.filter((entry) => entry.examples !== undefined);

const routedWithoutExamples = registry
  .filter((entry) => entry.status === "routed" && entry.examples === undefined)
  .map((entry) => entry.operationId)
  .sort();

test("src/http/contract/example.test", async (t) => {
  await t.test(
    "a node.claim request omitting available fails validation",
    () => {
      const result = findOperation("node.claim")!.request!.safeParse({});

      assert.equal(result.success, false);
      if (!result.success) {
        assert.deepEqual(result.error.issues[0]?.path, ["available"]);
      }
    },
  );

  await t.test(
    "nodeClaimResponse carries both run ids, both run fences, expiresAt and renewAfterMs",
    () => {
      const response = nodeClaimResponse.parse(
        findOperation("node.claim")!.examples!.success,
      ) as Record<string, unknown>;

      assert.equal(typeof response.runId, "string");
      assert.equal(typeof response.runFence, "number");
      assert.equal((response.runFence as number) >= 1, true);
      assert.equal(typeof response.objectiveRunId, "string");
      assert.equal(typeof response.objectiveRunFence, "number");
      assert.equal((response.objectiveRunFence as number) >= 1, true);
      assert.equal(Object.hasOwn(nodeClaimResponse.shape, "fence"), false);
      assert.equal(typeof response.expiresAt, "number");
      assert.equal((response.renewAfterMs as number) > 0, true);
    },
  );

  await t.test("heartbeatIntervalMs is absent from nodeClaimResponse", () => {
    assert.equal(
      Object.hasOwn(nodeClaimResponse.shape, "heartbeatIntervalMs"),
      false,
    );
  });

  await t.test(
    "a node.report omitting runId fails schema validation with the issue path runId",
    () => {
      const bodies: readonly Record<string, unknown>[] = [
        {
          report: "accepted",
          fence: 1,
          runFence: 1,
          objectId: "a".repeat(40),
        },
        { report: "rejected", fence: 1, runFence: 1, reason: "not good" },
        { report: "failed", fence: 1, runFence: 1, reason: "boom" },
        { report: "cancelled", fence: 1, runFence: 1 },
        {
          report: "attested",
          fence: 1,
          runFence: 1,
          objectId: "b".repeat(64),
        },
        { report: "closed", runFence: 1, acknowledgePartial: true },
      ];

      for (const body of bodies) {
        const result = nodeReportRequest.safeParse(body);
        assert.equal(result.success, false, JSON.stringify(body));
        if (!result.success) {
          const issue = result.error.issues.find(
            (candidate) =>
              candidate.path.length === 1 && candidate.path[0] === "runId",
          );
          assert.notEqual(issue, undefined, JSON.stringify(body));
          if (issue !== undefined) {
            assert.deepEqual(issue.path, ["runId"]);
          }
        }
      }
    },
  );

  await t.test(
    "nodeRenewResponse carries expiresAt and renewAfterMs and no heartbeatIntervalMs",
    () => {
      const response = nodeRenewResponse.parse(
        findOperation("node.renew")!.examples!.success,
      ) as Record<string, unknown>;

      assert.equal(response.expiresAt, 1722800300000);
      assert.equal(response.renewAfterMs, 100000);
      assert.equal(Object.hasOwn(response, "heartbeatIntervalMs"), false);
    },
  );

  await t.test(
    "nodeRenewResponse carries objectiveExpiresAt and its example parses",
    () => {
      assert.equal(
        Object.hasOwn(nodeRenewResponse.shape, "objectiveExpiresAt"),
        true,
      );

      const response = nodeRenewResponse.parse(
        findOperation("node.renew")!.examples!.success,
      ) as Record<string, unknown>;

      assert.equal(response.objectiveExpiresAt, 1722800300000);

      const missing = nodeRenewResponse.safeParse({
        ...(findOperation("node.renew")!.examples!.success as Record<
          string,
          unknown
        >),
        objectiveExpiresAt: undefined,
      });
      assert.equal(missing.success, false);
      if (!missing.success) {
        assert.deepEqual(missing.error.issues[0]?.path, ["objectiveExpiresAt"]);
      }
    },
  );

  await t.test(
    "the node.renew objectiveExpiresAt field decision is published",
    () => {
      assert.equal(
        fieldDecisions.includes(
          "node.renew.response#/properties/objectiveExpiresAt required=true nullable=false enum=-",
        ),
        true,
      );
      assert.deepEqual(
        fieldDecisions.filter((row) => row.startsWith("node.renew.response#")),
        [
          "node.renew.response#/properties/expiresAt required=true nullable=false enum=-",
          "node.renew.response#/properties/lease required=true nullable=false enum=-",
          "node.renew.response#/properties/lease/properties/expiresAt required=true nullable=false enum=-",
          "node.renew.response#/properties/lease/properties/fence required=true nullable=false enum=-",
          "node.renew.response#/properties/lease/properties/owner required=true nullable=false enum=-",
          "node.renew.response#/properties/lease/properties/ownerKind required=true nullable=false enum=actor",
          "node.renew.response#/properties/lease/properties/subjectId required=true nullable=false enum=-",
          "node.renew.response#/properties/objectiveExpiresAt required=true nullable=false enum=-",
          "node.renew.response#/properties/objectiveLease required=true nullable=false enum=-",
          "node.renew.response#/properties/objectiveLease/properties/expiresAt required=true nullable=false enum=-",
          "node.renew.response#/properties/objectiveLease/properties/fence required=true nullable=false enum=-",
          "node.renew.response#/properties/objectiveLease/properties/owner required=true nullable=false enum=-",
          "node.renew.response#/properties/objectiveLease/properties/ownerKind required=true nullable=false enum=actor",
          "node.renew.response#/properties/objectiveLease/properties/subjectId required=true nullable=false enum=-",
          "node.renew.response#/properties/renewAfterMs required=true nullable=false enum=-",
        ],
      );
    },
  );

  await t.test("heartbeatIntervalMs appears in no contract schema", () => {
    const control = z.toJSONSchema(
      z.strictObject({ heartbeatIntervalMs: z.int() }),
      { target: "openapi-3.0", io: "input" },
    );
    assert.equal(JSON.stringify(control).includes("heartbeatIntervalMs"), true);

    for (const entry of registry) {
      if (entry.request !== undefined) {
        const schema = z.toJSONSchema(entry.request, {
          target: "openapi-3.0",
          io: "input",
        });
        assert.equal(
          JSON.stringify(schema).includes("heartbeatIntervalMs"),
          false,
          `${entry.operationId}.request`,
        );
      }
      if (entry.response !== undefined) {
        const schema = z.toJSONSchema(entry.response, {
          target: "openapi-3.0",
          io: "output",
        });
        assert.equal(
          JSON.stringify(schema).includes("heartbeatIntervalMs"),
          false,
          `${entry.operationId}.response`,
        );
      }
    }
  });

  await t.test("renewAfterMs is one third of runTtlMs", () => {
    const runTtlMs = 300000;
    const response = nodeRenewResponse.parse(
      findOperation("node.renew")!.examples!.success,
    );

    assert.equal(response.renewAfterMs, Math.floor(runTtlMs / 3));
  });

  await t.test("every example parses against its declared schema", () => {
    const covered = withExamples.map((entry) => entry.operationId).sort();
    assert.deepEqual(covered, [
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
      "provider.loginCancel",
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
    assert.deepEqual(
      withExamples
        .filter((entry) => entry.examples!.query !== undefined)
        .map((entry) => entry.operationId)
        .sort(),
      ["event.list", "node.list", "provider.catalog", "provider.remove"],
    );
    for (const entry of withExamples) {
      if (entry.query !== undefined) {
        assert.notEqual(
          entry.examples!.query,
          undefined,
          `${entry.operationId} declares a query schema but no query example`,
        );
        assert.doesNotThrow(
          () => entry.query!.parse(entry.examples!.query),
          `${entry.operationId}'s query example does not satisfy its query schema`,
        );
      } else {
        assert.equal(
          entry.examples!.query,
          undefined,
          `${entry.operationId} has no query schema but carries a query example`,
        );
      }
      if (entry.request !== undefined) {
        assert.notEqual(
          entry.examples!.request,
          undefined,
          `${entry.operationId} declares a request schema but no request example`,
        );
        assert.doesNotThrow(
          () => entry.request!.parse(entry.examples!.request),
          `${entry.operationId}'s request example does not satisfy its request schema`,
        );
      } else {
        assert.equal(
          entry.examples!.request,
          undefined,
          `${entry.operationId} has no request schema but carries a request example`,
        );
      }
      if (entry.response !== undefined) {
        assert.notEqual(
          entry.examples!.success,
          undefined,
          `${entry.operationId} declares a response schema but no success example`,
        );
        assert.doesNotThrow(
          () => entry.response!.parse(entry.examples!.success),
          `${entry.operationId}'s success example does not satisfy its response schema`,
        );
      } else {
        assert.equal(
          entry.examples!.success,
          undefined,
          `${entry.operationId} has no response schema but carries a success example`,
        );
      }
      if (entry.errors !== undefined) {
        assert.notEqual(
          entry.examples!.error,
          undefined,
          `${entry.operationId} declares errors but no error example`,
        );
        assert.doesNotThrow(
          () => buildErrorEnvelope(entry.errors!).parse(entry.examples!.error),
          `${entry.operationId}'s error example does not satisfy its own envelope`,
        );
      } else {
        assert.equal(
          entry.examples!.error,
          undefined,
          `${entry.operationId} has no declared errors but carries an error example`,
        );
      }
    }
  });

  await t.test(
    "every routed operation carries examples except blob.show",
    () => {
      assert.deepEqual(routedWithoutExamples, ["blob.show"]);
    },
  );

  await t.test("an error example naming an undeclared code fails", () => {
    const undeclared = {
      error: {
        code: "plan-invalid",
        message: "m",
        details: { findings: [] },
      },
    };
    assert.throws(() =>
      buildErrorEnvelope(findOperation("project.list")!.errors!).parse(
        undeclared,
      ),
    );
    assert.doesNotThrow(() =>
      buildErrorEnvelope(findOperation("plan.import")!.errors!).parse(
        undeclared,
      ),
    );
  });

  await t.test("a broken example fails its schema", () => {
    assert.throws(() =>
      findOperation("project.create")!.response!.parse({
        id: "x",
        name: "y",
        repositories: [],
        updatedAt: "not-a-number",
      }),
    );
    for (const entry of withExamples) {
      assert.throws(
        () =>
          buildErrorEnvelope(entry.errors!).parse({
            error: { code: "invalid-request", message: 7 },
          }),
        `${entry.operationId}'s envelope accepted a non-string message`,
      );
    }
  });

  await t.test("no stubbed operation carries an example", () => {
    for (const entry of registry) {
      if (entry.status === "stubbed") {
        assert.equal(
          entry.examples,
          undefined,
          `${entry.operationId} is stubbed but carries an example`,
        );
      }
    }
  });

  await t.test("blob.show carries no example", () => {
    assert.equal(findOperation("blob.show")?.examples, undefined);
  });

  await t.test("every example is a plain JSON value", () => {
    for (const entry of withExamples) {
      assert.deepEqual(
        JSON.parse(JSON.stringify(entry.examples)),
        entry.examples,
      );
    }
  });
});
