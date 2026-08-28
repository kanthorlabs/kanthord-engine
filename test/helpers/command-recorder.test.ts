import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createCommandRecorder,
  resolveOperationId,
  type RecordedRequest,
} from "./command-recorder.ts";
import { registry } from "../../src/http/contract/registry.ts";

const respond = (request: RecordedRequest): unknown => {
  if (request.operationId === "project.list") {
    return { projects: [] };
  }
  if (request.operationId === "event.list") {
    return { events: [] };
  }
  return {};
};

describe("test/helpers/command-recorder.test", () => {
  it("resolves a concrete path to its one operation id", () => {
    assert.equal(resolveOperationId("GET", "/v1/project"), "project.list");
  });

  it("resolves a parameter segment", () => {
    assert.equal(
      resolveOperationId(
        "GET",
        "/v1/project/project_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      ),
      "project.show",
    );
  });

  it("ignores the query string", () => {
    assert.equal(resolveOperationId("GET", "/v1/event?limit=10"), "event.list");
  });

  it("throws naming the method and path when no template matches", () => {
    assert.throws(
      () => resolveOperationId("GET", "/v1/nowhere"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /GET/);
        assert.match(error.message, /\/v1\/nowhere/);
        return true;
      },
    );
  });

  it("throws naming every match when two templates match", () => {
    const projectList = registry.find(
      (entry) => entry.operationId === "project.list",
    );
    assert.ok(projectList);
    const duplicateEntries = [
      { ...projectList, operationId: "fixture.first" },
      { ...projectList, operationId: "fixture.second" },
    ];

    assert.throws(
      () => resolveOperationId("GET", "/v1/project", duplicateEntries),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /fixture\.first/);
        assert.match(error.message, /fixture\.second/);
        return true;
      },
    );
  });

  it("records the request one CLI leaf issues", async () => {
    const recorder = createCommandRecorder({ respond });

    await recorder.run(["project", "list"]);

    assert.deepEqual(recorder.operationIds(), ["project.list"]);
  });

  it("records zero requests and one migrate call for db migrate", async () => {
    const recorder = createCommandRecorder({ respond });

    await recorder.run(["db", "migrate"]);

    assert.deepEqual(recorder.operationIds(), []);
    assert.equal(recorder.migrateCalls(), 1);
  });

  it("records plan document writes separately from config writes", async () => {
    const recorder = createCommandRecorder({
      respond: (request) =>
        request.operationId === "plan.export"
          ? { revision: null, documents: [{ path: "plan/a.md", content: "a" }] }
          : {},
      fs: {
        readDirectory: () => [],
        readFile: () => "",
        writeFile: () => undefined,
        makeDirectory: () => undefined,
        removeFile: () => undefined,
      },
    });

    await recorder.run(["plan", "export", "--project", "project_test"]);

    assert.deepEqual(recorder.writeFileCalls(), []);
    assert.deepEqual(recorder.planWriteFileCalls(), [
      {
        path: "/tmp/kanthord-command-recorder/plan/a.md",
        content: "a",
      },
    ]);
  });

  it("issues no network request", async () => {
    const recorder = createCommandRecorder({ respond });

    await recorder.run(["project", "list"]);

    assert.equal(recorder.requests().length, 1);
    assert.deepEqual(recorder.operationIds(), ["project.list"]);
  });

  it("keeps two runs independent", async () => {
    const recorder = createCommandRecorder({ respond });

    await recorder.run(["project", "list"]);
    await recorder.run(["event", "list"]);

    assert.deepEqual(recorder.operationIds(), ["project.list", "event.list"]);
  });
});
