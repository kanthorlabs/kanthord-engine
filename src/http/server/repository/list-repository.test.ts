import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { createMigratedStorage } from "../../../../test/helpers/database.ts";
import { listRepositoryHandler } from "./list-repository.ts";
import type { RepositoryView } from "../../../queries/repository/show-repository.ts";
import { repositoryListResponse } from "../../contract/repository.ts";

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
  listRepositories: (input: {
    state?: "ready" | "needs-reconcile";
  }) => Promise<readonly RepositoryView[]>,
) {
  return createTestApp({
    handlers: {
      "repository.list": listRepositoryHandler({ listRepositories }),
    },
  });
}

function assertNoDaemonPath(body: unknown): void {
  const text = JSON.stringify(body);
  assert.equal(text.includes(daemonHome), false, text);
  assert.equal(/\/\.git/.test(text), false, text);
}

function counts(
  temporary: ReturnType<typeof createMigratedStorage>,
  table: "repository" | "event",
): number {
  return temporary.storage.transact(
    (transaction) =>
      (transaction.get(`SELECT COUNT(*) AS c FROM ${table}`) as { c: number })
        .c,
  );
}

describe("src/http/server/repository/list-repository.test", () => {
  it("GET /v1/repository answers 200 with the list and the response schema parses the body", async () => {
    let called: { state?: "ready" | "needs-reconcile" } | undefined;
    const app = await handlerApp(async (input) => {
      called = input;
      return [view];
    });
    const response = await app.get("/v1/repository");
    assert.equal(response.status, 200);
    assert.equal(repositoryListResponse.safeParse(response.body).success, true);
    assert.deepEqual(called, {});
    assert.deepEqual(response.body, { repositories: [view] });
    assertNoDaemonPath(response.body);
  });

  it("POST /v1/repository/<id>/reconcile answers 501 ships in phase-2 and writes nothing", async () => {
    const temporary = createMigratedStorage();
    try {
      const repositoryBefore = counts(temporary, "repository");
      const eventBefore = counts(temporary, "event");
      const app = await createTestApp({});
      const response = await app.post(
        `/v1/repository/${repositoryId}/reconcile`,
      );
      assert.equal(response.status, 501);
      assert.ok(
        String(response.body.error.message).endsWith("ships in phase-2"),
        String(response.body.error.message),
      );
      assert.equal(counts(temporary, "repository"), repositoryBefore);
      assert.equal(counts(temporary, "event"), eventBefore);
    } finally {
      temporary.dispose();
    }
  });
});
