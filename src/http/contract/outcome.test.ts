import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { nodeReportRequest, nodeReportResponse } from "./outcome.ts";
import { findOperation } from "./registry.ts";
import { renderPath } from "./path.ts";

const OID40 = "a".repeat(40);
const OID64 = "b".repeat(64);

const validBodies = [
  { report: "accepted", fence: 1, objectId: OID40 },
  { report: "rejected", fence: 1, reason: "not good" },
  { report: "failed", fence: 1, reason: "boom" },
  { report: "cancelled", fence: 1 },
  { report: "cancelled", fence: 1, reason: "giving up" },
  { report: "attested", fence: 1, objectId: OID64 },
  { report: "closed", acknowledgePartial: true },
];

describe("src/http/contract/outcome.test", () => {
  it("nodeReportRequest parses each of the six report kinds", () => {
    for (const body of validBodies) {
      const parsed = nodeReportRequest.safeParse(body);
      assert.equal(parsed.success, true, JSON.stringify(body));
      if (parsed.success) {
        assert.equal(parsed.data.report, body.report);
      }
    }
  });

  it("nodeReportRequest refuses a body that matches no member", () => {
    const bodies = [
      { report: "timed-out", fence: 1 },
      { report: "expired", fence: 1 },
      { report: "accepted" },
      { report: "rejected", fence: 1 },
      { report: "failed", reason: "boom" },
      { report: "attested", objectId: OID40 },
      { report: "closed", acknowledgePartial: "yes" },
      { report: "closed" },
      { report: "accepted", fence: 1, objectId: OID40, reason: "why not" },
      { report: "accepted", fence: 1.5, objectId: OID40 },
      { report: "attested", fence: 1, objectId: "not-hex" },
    ];
    for (const body of bodies) {
      assert.equal(
        nodeReportRequest.safeParse(body).success,
        false,
        JSON.stringify(body),
      );
    }
  });

  it("nodeReportRequest refuses an owner key on every member", () => {
    const withOwner = validBodies.map((body) => ({
      ...body,
      owner: "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR",
    }));
    for (const body of withOwner) {
      assert.equal(
        nodeReportRequest.safeParse(body).success,
        false,
        JSON.stringify(body),
      );
    }
  });

  it("nodeReportResponse parses a full result and refuses an unknown key", () => {
    const full = {
      nodeId: `task_01JQ8Z7G3HZZZZZZZZZZZZZZZZ`,
      kind: "task",
      state: "done",
      blockReason: null,
      attemptId: `attempt_01JQ8Z7G3HZZZZZZZZZZZZZZZZ`,
      attemptNo: 1,
      attemptsRemaining: 2,
      objectId: OID40,
      objectiveState: "running",
      objectiveProjection: null,
    };
    assert.equal(nodeReportResponse.safeParse(full).success, true);
    assert.equal(
      nodeReportResponse.safeParse({ ...full, extra: 1 }).success,
      false,
    );
    assert.equal(
      nodeReportResponse.safeParse({ ...full, objectId: "not-hex" }).success,
      false,
    );
  });

  it("node.report declares its path in the registry", () => {
    const entry = findOperation("node.report");
    assert.notEqual(entry, undefined);
    assert.equal(entry!.method, "POST");
    assert.equal(renderPath(entry!.path), "/v1/node/:id/report");
  });
});
