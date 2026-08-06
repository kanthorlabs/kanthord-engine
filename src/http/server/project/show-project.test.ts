import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { showProjectHandler } from "./show-project.ts";
import type { ProjectView } from "../../../domain/project-view.ts";
import { projectShowResponse } from "../../contract/project.ts";

const projectId = "project_01HZY8QF3M4N5P6R7S8T9V0W1X";
const daemonHome = "/var/lib/kanthord";

const view: ProjectView = {
  id: projectId,
  name: "kanthord-verify",
  repositories: ["repo_a"],
  updatedAt: 1700000000000,
};

describe("src/http/server/project/show-project.test", () => {
  it("GET /v1/project/<id> answers 200 and the response schema parses the body", async () => {
    let called: { id: string } | undefined;
    const app = await createTestApp({
      handlers: {
        "project.show": showProjectHandler({
          showProject: (input) => {
            called = input;
            return view;
          },
        }),
      },
    });

    const response = await app.get(`/v1/project/${projectId}`);

    assert.equal(response.status, 200);
    assert.equal(projectShowResponse.safeParse(response.body).success, true);
    assert.deepEqual(called, { id: projectId });
    assert.equal(
      JSON.stringify(response.body).includes(daemonHome),
      false,
      JSON.stringify(response.body),
    );
  });

  it("GET /v1/project/<id> with a null result answers 404 naming the id", async () => {
    const app = await createTestApp({
      handlers: {
        "project.show": showProjectHandler({
          showProject: () => null,
        }),
      },
    });

    const response = await app.get(`/v1/project/${projectId}`);

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
    assert.ok(
      String(response.body.error.message).includes(projectId),
      String(response.body.error.message),
    );
  });
});
