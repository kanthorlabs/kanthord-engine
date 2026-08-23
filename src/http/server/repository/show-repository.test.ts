import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { showRepositoryHandler } from "./show-repository.ts";
import type { RepositoryView } from "../../../queries/repository/show-repository.ts";
import { repositoryShowResponse } from "../../contract/repository.ts";

const view: RepositoryView = {
  id: "repo_01HZY8QF3M4N5P6R7S8T9V0W1A",
  name: "kanthord-verify",
  remoteUrl: "https://github.com/kanthorlabs/kanthord-verify.git",
  credential: {
    id: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
    name: "github-bot",
  },
  branch: "main",
  landingRef: "refs/heads/main",
  trackingRef: "refs/remotes/origin/main",
  publishRef: "refs/heads/main",
  publishOnApproval: true,
  state: "ready",
  landingOid: "1".repeat(40),
  trackingOid: "2".repeat(40),
  fetchedUpstreamOid: "f".repeat(40),
  divergedLandingOid: null,
  divergedUpstreamOid: null,
  updatedAt: 1700000000000,
};

const repositoryId = "repo_01HZY8QF3M4N5P6R7S8T9V0W1A";
const daemonHome = "/var/lib/kanthord";
const daemonPath = `${daemonHome}/repos/kanthord-verify/.git`;

async function handlerApp(
  showRepository: (input: { id: string }) => Promise<RepositoryView | null>,
) {
  return createTestApp({
    handlers: {
      "repository.show": showRepositoryHandler({ showRepository }),
    },
  });
}

function assertNoDaemonPath(body: unknown): void {
  const text = JSON.stringify(body);
  assert.equal(text.includes(daemonHome), false, text);
  assert.equal(/\/\.git/.test(text), false, text);
}

describe("src/http/server/repository/show-repository.test", () => {
  it("GET /v1/repository/<id> answers 200 and the response schema parses the body", async () => {
    let called: { id: string } | undefined;
    const app = await handlerApp(async (input) => {
      called = input;
      return view;
    });
    const response = await app.get(`/v1/repository/${repositoryId}`);
    assert.equal(response.status, 200);
    assert.equal(repositoryShowResponse.safeParse(response.body).success, true);
    assert.deepEqual(called, { id: repositoryId });
    assertNoDaemonPath(response.body);
  });

  it("GET /v1/repository/<id> with a null result answers 404 naming the id", async () => {
    const app = await handlerApp(async () => null);
    const response = await app.get(`/v1/repository/${repositoryId}`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
    assert.ok(
      String(response.body.error.message).includes(repositoryId),
      String(response.body.error.message),
    );
  });
});
