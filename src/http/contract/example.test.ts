import assert from "node:assert/strict";
import { test } from "node:test";

import { baselineErrors } from "./error-baseline.ts";
import { buildErrorEnvelope } from "./errors.ts";
import { findOperation, registry } from "./registry.ts";

const scoped = registry.filter(
  (entry) =>
    entry.status === "routed" &&
    entry.introducedIn === "phase-1" &&
    entry.operationId !== "blob.show",
);

test("src/http/contract/example.test", async (t) => {
  await t.test("covers the thirty-four phase-1 routed operations", () => {
    assert.equal(scoped.length, 34);
    for (const entry of scoped) {
      assert.notEqual(
        entry.examples,
        undefined,
        `${entry.operationId} is missing examples`,
      );
    }
  });

  await t.test("every success example satisfies its response schema", () => {
    for (const entry of scoped) {
      assert.notEqual(
        entry.response,
        undefined,
        `${entry.operationId} has no response schema`,
      );
      assert.doesNotThrow(
        () => entry.response!.parse(entry.examples!.success),
        `${entry.operationId}'s success example does not satisfy its response schema`,
      );
    }
  });

  await t.test("every request example satisfies its request schema", () => {
    for (const entry of scoped) {
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
    }
  });

  await t.test("every query example satisfies its query schema", () => {
    const withQueryExample = scoped.filter(
      (entry) => entry.examples!.query !== undefined,
    );
    assert.deepEqual(
      withQueryExample.map((entry) => entry.operationId),
      ["event.list", "node.list"],
    );
    for (const entry of scoped) {
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
    }
  });

  await t.test(
    "every error example satisfies its own operation's envelope",
    () => {
      for (const entry of scoped) {
        assert.notEqual(
          entry.errors,
          undefined,
          `${entry.operationId} has no declared errors`,
        );
        assert.doesNotThrow(
          () => buildErrorEnvelope(entry.errors!).parse(entry.examples!.error),
          `${entry.operationId}'s error example does not satisfy its own envelope`,
        );
      }
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
    for (const entry of scoped) {
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
    for (const entry of scoped) {
      assert.deepEqual(
        JSON.parse(JSON.stringify(entry.examples)),
        entry.examples,
      );
    }
  });
});
