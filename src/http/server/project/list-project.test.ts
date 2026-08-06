import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { listProjectHandler } from "./list-project.ts";
import type { ProjectView } from "../../../domain/project-view.ts";
import { projectListResponse } from "../../contract/project.ts";

const daemonHome = "/var/lib/kanthord";

const views: readonly ProjectView[] = [
  {
    id: "project_a",
    name: "kanthord-verify",
    repositories: ["repo_a"],
    updatedAt: 1,
  },
  {
    id: "project_b",
    name: "beta-project",
    repositories: [],
    updatedAt: 2,
  },
];

describe("src/http/server/project/list-project.test", () => {
  it("GET /v1/project answers 200 with the projects under a projects key", async () => {
    let called = false;
    const app = await createTestApp({
      handlers: {
        "project.list": listProjectHandler({
          listProjects: () => {
            called = true;
            return views;
          },
        }),
      },
    });

    const response = await app.get("/v1/project");

    assert.equal(response.status, 200);
    assert.equal(called, true);
    assert.deepEqual(response.body, { projects: views });
    assert.equal(projectListResponse.safeParse(response.body).success, true);
    assert.equal(
      JSON.stringify(response.body).includes(daemonHome),
      false,
      JSON.stringify(response.body),
    );
  });
});
