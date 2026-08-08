import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { project, projectStatusResponse } from "./project.ts";
import { renderPath } from "./path.ts";

describe("src/http/contract/project-status.test", () => {
  it("registers project.status as a routed GET under /v1/project/:id/status", () => {
    const operation = project.find(
      (entry) => entry.operationId === "project.status",
    );

    assert.ok(operation !== undefined, "project.status is not registered");
    assert.equal(operation?.method, "GET");
    assert.equal(renderPath(operation?.path ?? []), "/v1/project/:id/status");
    assert.equal(operation?.status, "routed");
    assert.equal(operation?.response, projectStatusResponse);
  });

  it("projectStatusResponse accepts an empty nodes list and a populated one", () => {
    assert.equal(projectStatusResponse.safeParse({ nodes: [] }).success, true);
    assert.equal(
      projectStatusResponse.safeParse({
        nodes: [
          { kind: "task", state: "pending", blockReason: null, count: 4 },
        ],
      }).success,
      true,
    );
  });

  it("rejects an unknown key on a node line", () => {
    assert.equal(
      projectStatusResponse.safeParse({
        nodes: [
          {
            kind: "task",
            state: "pending",
            blockReason: null,
            count: 4,
            extra: 1,
          },
        ],
      }).success,
      false,
    );
  });

  it("rejects an unknown key on the response itself", () => {
    assert.equal(
      projectStatusResponse.safeParse({ nodes: [], extra: 1 }).success,
      false,
    );
  });
});
