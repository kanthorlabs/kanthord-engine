import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { call } from "./cli/client.ts";
import type { ClientDependencies } from "./cli/client.ts";
import { createTemporaryHome } from "../test/helpers/home.ts";
import type { TemporaryHome } from "../test/helpers/home.ts";
import { launchDaemon } from "../test/helpers/daemon.ts";
import type { DaemonProcess } from "../test/helpers/daemon.ts";
import {
  createHttpRemote,
  type HttpRemote,
} from "../test/helpers/remote/index.ts";
import { runCli } from "../test/helpers/cli.ts";
import { reservePort } from "../test/helpers/port.ts";
import { resolveTools } from "../test/helpers/remote/tools.ts";

const REPOSITORY_NAME = "branch-fixture";

let home: TemporaryHome | undefined;
let daemon: DaemonProcess | undefined;
let port = 0;
let remote: HttpRemote | undefined;
const humanToken = "test-token";

function clientDependencies(): ClientDependencies {
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token: humanToken,
    fetch: globalThis.fetch,
  };
}

describe("src/main.repository-branch.test", () => {
  before(async () => {
    remote = await createHttpRemote();
    home = createTemporaryHome();
    port = await reservePort();
    const configPath = home.writeConfig({
      http: { port, allowedHosts: [`127.0.0.1:${port}`] },
    });
    const migrated = await runCli({
      args: ["db", "migrate", "--home", home.path],
    });
    assert.equal(migrated.code, 0, migrated.stderr);
    daemon = launchDaemon({ configPath });
    await daemon.ready();
  });

  after(async () => {
    if (daemon !== undefined) {
      daemon.kill("SIGTERM");
      await daemon.exited();
    }
    if (home !== undefined) {
      home.dispose();
    }
    if (remote !== undefined) {
      await remote.dispose();
    }
  });

  it("a registration seeds a bare home whose only local head is the one branch, and the view reports the derived refs", async () => {
    assert.ok(remote !== undefined);
    assert.ok(home !== undefined);
    const branch = "main";

    const provider = await call(clientDependencies(), {
      operationId: "provider.register",
      body: {
        name: "fixture-writer",
        kind: "git",
        payload: {
          transport: "http-basic",
          forge: "github",
          username: remote.credentials.writer.username,
          token: remote.credentials.writer.token,
        },
      },
    });
    if (!provider.ok) {
      assert.fail(JSON.stringify(provider));
    }
    const credentialId = (provider.body as { id: string }).id;

    const registered = await call(clientDependencies(), {
      operationId: "repository.register",
      body: {
        name: REPOSITORY_NAME,
        remoteUrl: remote.url("fixture.git"),
        credentialId,
        branch,
        publishOnApproval: true,
        hostFingerprint: null,
      },
    });
    if (!registered.ok) {
      assert.fail(JSON.stringify(registered));
    }

    const shown = await call(clientDependencies(), {
      operationId: "repository.show",
      parameters: { id: (registered.body as { id: string }).id },
    });
    if (!shown.ok) {
      assert.fail(JSON.stringify(shown));
    }
    const view = shown.body as Record<string, unknown>;
    assert.equal(view.branch, branch);
    assert.equal(view.landingRef, `refs/heads/${branch}`);
    assert.equal(view.trackingRef, `refs/remotes/origin/${branch}`);
    assert.equal(view.publishRef, `refs/heads/${branch}`);
    assert.equal("upstreamBranch" in view, false);
    assert.equal("landingBranch" in view, false);

    const gitDir = join(home.path, "repos", `${REPOSITORY_NAME}.git`);
    const heads = execFileSync(
      resolveTools().paths.git,
      [
        "--git-dir=" + gitDir,
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads",
      ],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    assert.deepEqual(heads, [`refs/heads/${branch}`]);
  });
});
