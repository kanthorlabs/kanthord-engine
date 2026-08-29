import assert from "node:assert/strict";
import { test } from "node:test";

import { buildErrorEnvelope } from "./errors.ts";
import { findOperation, registry } from "./registry.ts";

const withExamples = registry.filter((entry) => entry.examples !== undefined);

const routedWithoutExamples = registry
  .filter((entry) => entry.status === "routed" && entry.examples === undefined)
  .map((entry) => entry.operationId)
  .sort();

test("src/http/contract/example.test", async (t) => {
  await t.test("every example parses against its declared schema", () => {
    const covered = withExamples.map((entry) => entry.operationId).sort();
    assert.deepEqual(covered, [
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
