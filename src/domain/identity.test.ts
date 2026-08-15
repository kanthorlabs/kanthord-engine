import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  identityKinds,
  identityPrefixes,
  parseIdentity,
  assertIdentity,
  identity,
  anyIdentity,
  nodeIdentity,
  identityTime,
  IdentityError,
} from "./identity.ts";

describe("src/domain/identity.test", () => {
  it("identityKinds has 18 entries", () => {
    assert.equal(identityKinds.length, 18);
  });

  it("identityPrefixes has 18 keys", () => {
    assert.equal(Object.keys(identityPrefixes).length, 18);
  });

  it("all 18 prefixes are unique", () => {
    assert.equal(new Set(Object.values(identityPrefixes)).size, 18);
  });

  it("identityPrefixes.actor is actor", () => {
    assert.equal(identityPrefixes.actor, "actor");
  });

  it("the five renamed prefixes are exact strings", () => {
    assert.equal(identityPrefixes.repository, "repo");
    assert.equal(identityPrefixes.planRevision, "revision");
    assert.equal(identityPrefixes.agentInvocation, "invocation");
    assert.equal(identityPrefixes.checkResult, "check");
    assert.equal(identityPrefixes.gitOperation, "gitop");
  });

  for (const kind of identityKinds) {
    it(`parseIdentity round-trips ${kind}`, () => {
      const result = parseIdentity(
        `${identityPrefixes[kind]}_01HZY8QF3M4N5P6R7S8T9V0W1X`,
      );
      assert.deepEqual(result, {
        kind,
        prefix: identityPrefixes[kind],
        ulid: "01HZY8QF3M4N5P6R7S8T9V0W1X",
      });
    });
  }

  const nullCases: ReadonlyArray<[string, string]> = [
    ["empty string", ""],
    ["no prefix", "01HZY8QF3M4N5P6R7S8T9V0W1X"],
    ["unknown prefix", "widget_01HZY8QF3M4N5P6R7S8T9V0W1X"],
    ["empty ulid", "project_"],
    ["lowercase", "project_01hzy8qf3m4n5p6r7s8t9v0w1x"],
    ["25 chars", "project_01HZY8QF3M4N5P6R7S8T9V0W1"],
    ["27 chars", "project_01HZY8QF3M4N5P6R7S8T9V0W1XX"],
    ["contains I", "project_01HZY8QF3M4N5P6R7S8T9V0WIX"],
    ["contains L", "project_01HZY8QF3M4N5P6R7S8T9V0WLX"],
    ["contains O", "project_01HZY8QF3M4N5P6R7S8T9V0WOX"],
    ["contains U", "project_01HZY8QF3M4N5P6R7S8T9V0WUX"],
    ["leading 8 overflows", "project_81HZY8QF3M4N5P6R7S8T9V0W1X"],
    ["leading Z", "project_Z1HZY8QF3M4N5P6R7S8T9V0W1X"],
  ];

  for (const [label, input] of nullCases) {
    it(`parseIdentity returns null for ${label}`, () => {
      assert.equal(parseIdentity(input), null);
    });
  }

  it("parseIdentity splits on first underscore only", () => {
    const result = parseIdentity("gitop_01HZY8QF3M4N5P6R7S8T9V0W1X");
    assert.equal(result?.kind, "gitOperation");
  });

  it("assertIdentity returns Identity for matching kind", () => {
    const result = assertIdentity("task_01HZY8QF3M4N5P6R7S8T9V0W1X", "task");
    assert.equal(result.kind, "task");
  });

  it("assertIdentity throws IdentityError for kind mismatch", () => {
    assert.throws(
      () => assertIdentity("task_01HZY8QF3M4N5P6R7S8T9V0W1X", "objective"),
      (error: unknown) => {
        assert.ok(error instanceof IdentityError);
        assert.equal(error.code, "identity-kind-mismatch");
        assert.equal(
          error.message,
          "task_01HZY8QF3M4N5P6R7S8T9V0W1X is not a objective identity",
        );
        return true;
      },
    );
  });

  it("assertIdentity throws IdentityError for unparseable input", () => {
    assert.throws(
      () => assertIdentity("nonsense", "task"),
      (error: unknown) => {
        assert.ok(error instanceof IdentityError);
        assert.equal(error.code, "identity-kind-mismatch");
        return true;
      },
    );
  });

  it("identity schema accepts matching kind", () => {
    const result = identity("project").safeParse(
      "project_01HZY8QF3M4N5P6R7S8T9V0W1X",
    );
    assert.equal(result.success, true);
  });

  it("identity schema rejects wrong kind", () => {
    const result = identity("project").safeParse(
      "repo_01HZY8QF3M4N5P6R7S8T9V0W1X",
    );
    assert.equal(result.success, false);
  });

  it("identity memoises schema per kind", () => {
    assert.equal(identity("project"), identity("project"));
  });

  it("nodeIdentity accepts initiative, objective, task", () => {
    for (const kind of ["initiative", "objective", "task"] as const) {
      const result = nodeIdentity.safeParse(
        `${identityPrefixes[kind]}_01HZY8QF3M4N5P6R7S8T9V0W1X`,
      );
      assert.equal(result.success, true, `expected ${kind} to be accepted`);
    }
  });

  it("nodeIdentity rejects non-node kind", () => {
    const result = nodeIdentity.safeParse("repo_01HZY8QF3M4N5P6R7S8T9V0W1X");
    assert.equal(result.success, false);
  });

  it("anyIdentity accepts one identity of every kind", () => {
    for (const kind of identityKinds) {
      const result = anyIdentity.safeParse(
        `${identityPrefixes[kind]}_01HZY8QF3M4N5P6R7S8T9V0W1X`,
      );
      assert.equal(result.success, true, `expected ${kind} to be accepted`);
    }
  });

  it("anyIdentity rejects unknown prefix", () => {
    const result = anyIdentity.safeParse("widget_01HZY8QF3M4N5P6R7S8T9V0W1X");
    assert.equal(result.success, false);
  });

  it("identityTime decodes the first 10 ULID characters", () => {
    assert.equal(
      identityTime("event_01HZY8QF3M4N5P6R7S8T9V0W1X"),
      1717928967284,
    );
  });

  it("identityTime ignores the prefix", () => {
    assert.equal(
      identityTime("task_01HZY8QF3M4N5P6R7S8T9V0W1X"),
      1717928967284,
    );
  });

  it("identityTime returns null for an unparseable input", () => {
    assert.equal(identityTime("0000000000000000000000000000"), null);
    assert.equal(identityTime("widget_01HZY8QF3M4N5P6R7S8T9V0W1X"), null);
  });

  it("identityTime decodes a zero timestamp", () => {
    assert.equal(identityTime("event_00000000000000000000000000"), 0);
  });

  it("identityTime decodes the largest 48-bit timestamp", () => {
    assert.equal(
      identityTime("event_7ZZZZZZZZZ0000000000000000"),
      281474976710655,
    );
  });
});
