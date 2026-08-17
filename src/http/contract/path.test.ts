import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  action,
  actionSegments,
  hash,
  parameter,
  parameterNames,
  renderOpenApiPath,
  renderPath,
  resource,
  resourceSegments,
  sub,
  subresourceSegments,
  system,
  systemLeafSegments,
  systemNamespaceSegments,
  systemSegments,
} from "./path.ts";

describe("src/http/contract/path.test", () => {
  it("keeps every closed array sorted bytewise and duplicate-free", () => {
    for (const segments of [
      resourceSegments,
      subresourceSegments,
      actionSegments,
      systemNamespaceSegments,
      systemLeafSegments,
      systemSegments,
    ]) {
      assert.deepEqual([...segments].sort(), segments);
      assert.equal(new Set(segments).size, segments.length);
    }
  });

  it("pins the closed-array sizes", () => {
    assert.equal(resourceSegments.length, 14);
    assert.equal(subresourceSegments.length, 15);
    assert.equal(actionSegments.length, 23);
    assert.equal(systemSegments.length, 3);
  });

  it("node is a subresource segment and update and delete are action segments", () => {
    assert.ok(subresourceSegments.includes("node"));
    assert.ok(actionSegments.includes("update"));
    assert.ok(actionSegments.includes("delete"));
    assert.equal(
      renderPath([resource("project"), parameter("project"), sub("node")]),
      "/v1/project/:id/node",
    );
    assert.equal(
      renderPath([resource("node"), parameter("node"), action("update")]),
      "/v1/node/:id/update",
    );
    assert.equal(
      renderPath([resource("node"), parameter("node"), action("delete")]),
      "/v1/node/:id/delete",
    );
  });

  it("claim, heartbeat and release are action segments under the node parameter", () => {
    for (const segment of ["claim", "heartbeat", "release"] as const) {
      assert.ok(actionSegments.includes(segment), `${segment} is missing`);
    }
    assert.equal(
      renderPath([resource("node"), parameter("node"), action("claim")]),
      "/v1/node/:id/claim",
    );
    assert.equal(
      renderPath([resource("node"), parameter("node"), action("heartbeat")]),
      "/v1/node/:id/heartbeat",
    );
    assert.equal(
      renderPath([resource("node"), parameter("node"), action("release")]),
      "/v1/node/:id/release",
    );
  });

  it("report is an action segment under the node parameter", () => {
    assert.ok(actionSegments.includes("report"));
    assert.equal(
      renderPath([resource("node"), parameter("node"), action("report")]),
      "/v1/node/:id/report",
    );
  });

  it("keeps every resource and subresource segment singular", () => {
    const singularDespiteTrailingS = new Set(["status"]);
    for (const segments of [resourceSegments, subresourceSegments]) {
      for (const segment of segments) {
        if (singularDespiteTrailingS.has(segment)) continue;
        assert.equal(segment.endsWith("s"), false, `${segment} is plural`);
      }
    }
  });

  it("renders a one-segment system path", () => {
    assert.equal(renderPath([system("health")]), "/v1/health");
  });

  it("renders a namespace-then-leaf system path", () => {
    assert.equal(renderPath([system("db"), system("status")]), "/v1/db/status");
  });

  it("renders a parameter as a colon segment", () => {
    assert.equal(
      renderPath([resource("node"), parameter("node"), action("unblock")]),
      "/v1/node/:id/unblock",
    );
  });

  it("renders the hash segment", () => {
    assert.equal(renderPath([resource("blob"), hash()]), "/v1/blob/:hash");
  });

  it("renders an empty path as the v1 root", () => {
    assert.equal(renderPath([]), "/v1");
  });

  it("templates a parameter in braces for OpenAPI", () => {
    assert.equal(renderOpenApiPath([system("health")]), "/v1/health");
    assert.equal(
      renderOpenApiPath([system("db"), system("status")]),
      "/v1/db/status",
    );
    assert.equal(
      renderOpenApiPath([
        resource("node"),
        parameter("node"),
        action("unblock"),
      ]),
      "/v1/node/{id}/unblock",
    );
    assert.equal(
      renderOpenApiPath([resource("blob"), hash()]),
      "/v1/blob/{hash}",
    );
  });

  it("lists parameter names in path order", () => {
    assert.deepEqual(parameterNames([system("health")]), []);
    assert.deepEqual(parameterNames([system("db"), system("status")]), []);
    assert.deepEqual(
      parameterNames([resource("node"), parameter("node"), action("unblock")]),
      ["id"],
    );
    assert.deepEqual(parameterNames([resource("blob"), hash()]), ["hash"]);
  });
});
