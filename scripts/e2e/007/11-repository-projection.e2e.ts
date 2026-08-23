import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadE2eEnv, type E2eEnv } from "../env.ts";
import { createTemporaryHome } from "../../../test/helpers/home.ts";
import {
  killAll,
  launchDaemon,
  type DaemonProcess,
} from "../../../test/helpers/daemon.ts";
import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import { SystemClock } from "../../../src/services/clock/system.ts";
import { SqliteStorage } from "../../../src/services/storage/sqlite.ts";
import { migrations } from "../../../src/services/storage/migrations.ts";
import { buildGitPaths } from "../../../src/services/git/probe.ts";
import { createGitRunner } from "../../../src/services/git/run.ts";
import { remoteRefValue } from "../../../src/services/git/preflight.ts";
import {
  repositoryListResponse,
  repositoryShowResponse,
} from "../../../src/http/contract/repository.ts";
import {
  assertScratchRef,
  deleteScratchRefs,
  httpsUrl,
  listRemoteRefs,
  scratchRef,
  writerCredential,
} from "../remote.ts";

async function request(
  url: string,
  init?: Readonly<{
    method?: string;
    headers?: Readonly<Record<string, string>>;
    body?: string;
  }>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.headers,
    body: init?.body,
  });
  const text = await response.text();
  const body: unknown = text === "" ? undefined : JSON.parse(text);
  return { status: response.status, body };
}

function baseBranchRef(env: E2eEnv): string {
  return `refs/heads/${env.ghBaseBranch}`;
}

describe("scripts/e2e/007/11-repository-projection.e2e", () => {
  it("E7-11 — the ref layout through the route alone", async (t) => {
    const env: E2eEnv = loadE2eEnv();
    const tools = resolveTools();
    const home = createTemporaryHome();
    const keyDirectory = mkdtempSync(
      join(tmpdir(), "kanthord-e2e-projection-keys-"),
    );
    const paths = buildGitPaths({
      probed: {
        git: tools.paths.git,
        ssh: tools.paths.ssh,
        sshKeyscan: tools.paths.sshKeyscan,
        gitVersion: tools.gitVersion,
        sshVersion: tools.sshVersion,
      },
      home: home.path,
    });
    let daemon: DaemonProcess | undefined;
    t.after(async () => {
      if (daemon !== undefined) {
        daemon.kill();
        await daemon.exited();
      }
      await deleteScratchRefs(paths, env);
      rmSync(keyDirectory, { recursive: true, force: true });
      home.dispose();
      await killAll();
    });

    const configPath = home.writeConfig({
      tools: {
        git: tools.paths.git,
        ssh: tools.paths.ssh,
        sshKeyscan: tools.paths.sshKeyscan,
      },
    });
    const migrated = new SqliteStorage({
      path: join(home.path, "kanthord.db"),
      clock: new SystemClock(),
      migrations,
    });
    migrated.migrate();
    migrated.close();

    daemon = launchDaemon({ configPath, home: home.path });
    await daemon.ready();

    const baseUrl = "http://127.0.0.1:7421";
    const auth = { Authorization: "Bearer test-token" };
    const json = { ...auth, "Content-Type": "application/json" };

    const registerCredential = async (
      name: string,
      payload: unknown,
    ): Promise<string> => {
      const response = await request(`${baseUrl}/v1/provider`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ name, kind: "git", payload }),
      });
      assert.equal(response.status, 200, `credential ${name} registers`);
      return (response.body as { id: string }).id;
    };

    const writerId = await registerCredential("e2e-projection-writer", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token: env.ghToken,
    });

    const inspected = await request(`${baseUrl}/v1/repository/inspect`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        remoteUrl: httpsUrl(env),
        credentialId: writerId,
      }),
    });
    assert.equal(inspected.status, 200, "the inspect answers 200");
    const defaultBranch = (inspected.body as { defaultBranch: string })
      .defaultBranch;
    assert.equal(defaultBranch, env.ghBaseBranch);

    const runner = createGitRunner(paths);
    const base = baseBranchRef(env);
    const writer = writerCredential(env);
    const baseOid = await remoteRefValue(runner, paths, {
      remoteUrl: httpsUrl(env),
      ref: base,
      credential: writer,
    });
    assert.ok(baseOid !== null, "the base branch resolves");
    assert.equal(/^[0-9a-f]{40}$/.test(baseOid), true, baseOid);

    const publishRef = scratchRef(env, "projection");
    assertScratchRef(env, publishRef);
    const runSuffix = env.runId.toLowerCase();
    const repoName = `kanthord-verify-${runSuffix}`;

    const registered = await request(`${baseUrl}/v1/repository`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        name: repoName,
        remoteUrl: httpsUrl(env),
        credentialId: writerId,
        branch: defaultBranch,
        publishOnApproval: true,
      }),
    });
    assert.equal(
      registered.status,
      200,
      `the register answers 200: ${JSON.stringify(registered.body)}`,
    );
    const repositoryId = (registered.body as { id: string }).id;

    const shown = await request(`${baseUrl}/v1/repository/${repositoryId}`, {
      method: "GET",
      headers: auth,
    });
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    assert.equal(repositoryShowResponse.safeParse(shown.body).success, true);
    const showBody = shown.body as Record<string, unknown>;

    assert.equal(showBody.landingRef, `refs/heads/${env.ghBaseBranch}`);
    assert.equal(
      showBody.trackingRef,
      `refs/remotes/origin/${env.ghBaseBranch}`,
    );
    assert.equal(showBody.state, "ready");
    assert.equal(showBody.divergedLandingOid, null);
    assert.equal(showBody.divergedUpstreamOid, null);
    assert.equal(showBody.publishOnApproval, true);
    assert.equal(showBody.publishRef, `refs/heads/${env.ghBaseBranch}`);
    assert.equal((showBody.credential as { id: string }).id, writerId);
    assert.equal(
      (showBody.credential as { name: string }).name,
      "e2e-projection-writer",
    );
    const landingOid = showBody.landingOid as string;
    const trackingOid = showBody.trackingOid as string;
    const fetchedUpstreamOid = showBody.fetchedUpstreamOid as string;
    for (const oid of [landingOid, trackingOid, fetchedUpstreamOid]) {
      assert.equal(/^[0-9a-f]{40}$/.test(oid), true, oid);
    }
    assert.equal(landingOid, baseOid);
    assert.equal(trackingOid, baseOid);
    assert.equal(fetchedUpstreamOid, baseOid);

    const shownText = JSON.stringify(showBody);
    assert.equal(/\/repos\//.test(shownText), false, shownText);
    assert.equal(shownText.includes(home.path), false, shownText);
    assert.equal(Object.hasOwn(showBody, "homePath"), false);
    assert.equal(shownText.includes(env.ghToken), false, shownText);

    const listed = await request(`${baseUrl}/v1/repository`, {
      method: "GET",
      headers: auth,
    });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(repositoryListResponse.safeParse(listed.body).success, true);
    const repositories = (listed.body as { repositories: { id: string }[] })
      .repositories;
    const found = repositories.find((entry) => entry.id === repositoryId);
    assert.ok(found !== undefined, "the registration appears in the list");
    assert.equal(
      JSON.stringify(listed.body).includes(home.path),
      false,
      "the list carries no daemon path",
    );

    const unknown = await request(
      `${baseUrl}/v1/repository/repo_01HZY8QF3M4N5P6R7S8T9V0W1X`,
      { method: "GET", headers: auth },
    );
    assert.equal(unknown.status, 404);
    assert.equal(
      (unknown.body as { error: { code: string } }).error.code,
      "not-found",
    );

    const reconciled = await request(
      `${baseUrl}/v1/repository/${repositoryId}/reconcile`,
      { method: "POST", headers: json },
    );
    assert.equal(reconciled.status, 501, JSON.stringify(reconciled.body));
    assert.ok(
      String(
        (reconciled.body as { error: { message: string } }).error.message,
      ).endsWith("ships in phase-2"),
    );
    const shownAgain = await request(
      `${baseUrl}/v1/repository/${repositoryId}`,
      { method: "GET", headers: auth },
    );
    assert.equal(shownAgain.status, 200);
    assert.deepEqual(shownAgain.body, showBody);

    assert.equal(
      await remoteRefValue(runner, paths, {
        remoteUrl: httpsUrl(env),
        ref: publishRef,
        credential: writer,
      }),
      null,
      "the scratch publish ref is absent after the registration",
    );
    assert.equal(
      await remoteRefValue(runner, paths, {
        remoteUrl: httpsUrl(env),
        ref: base,
        credential: writer,
      }),
      baseOid,
      "the base branch did not move",
    );
    const refs = await listRemoteRefs(
      paths,
      env,
      "refs/heads/kanthord-e2e/007/*",
    );
    const runRefs = Object.keys(refs).filter((ref) =>
      ref.endsWith(`-${env.runId}`),
    );
    assert.deepEqual(runRefs, [], "the scenario created no remote ref");
  });
});
