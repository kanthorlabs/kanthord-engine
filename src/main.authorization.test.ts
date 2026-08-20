import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { call } from "./cli/client.ts";
import type { ClientDependencies } from "./cli/client.ts";
import { createTemporaryHome } from "../test/helpers/home.ts";
import type { TemporaryHome } from "../test/helpers/home.ts";
import { launchDaemon } from "../test/helpers/daemon.ts";
import type { DaemonProcess } from "../test/helpers/daemon.ts";
import { reservePort } from "../test/helpers/port.ts";
import { runCli } from "../test/helpers/cli.ts";
import { seedRegistry } from "../test/helpers/rows.ts";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

describe("src/main.authorization.test", () => {
  let home: TemporaryHome | undefined;
  let daemon: DaemonProcess | undefined;
  let port = 0;
  let humanDependencies: ClientDependencies | undefined;
  let harnessDependencies: ClientDependencies | undefined;
  let projectId: string;
  let humanToken = "human-test-token";
  let harnessToken: string;

  before(async () => {
    home = createTemporaryHome();
    port = await reservePort();
    const configPath = home.writeConfig({
      http: { port, allowedHosts: [`127.0.0.1:${port}`], token: humanToken },
    });

    const migrated = await runCli({
      args: ["db", "migrate", "--home", home.path],
    });
    assert.equal(migrated.code, 0, migrated.stderr);

    const database = new DatabaseSync(join(home.path, "kanthord.db"));
    try {
      const adapter = {
        run: (sql: string, p: readonly unknown[] = []) => {
          database.prepare(sql).run(...(p as never[]));
        },
        get: (sql: string, p: readonly unknown[] = []) =>
          database.prepare(sql).get(...(p as never[])),
        all: (sql: string, p: readonly unknown[] = []) =>
          database.prepare(sql).all(...(p as never[])),
      };
      database.exec("BEGIN");
      try {
        seedRegistry(adapter);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }

    daemon = launchDaemon({ configPath });
    await daemon.ready();

    humanDependencies = {
      baseUrl: `http://127.0.0.1:${port}`,
      token: humanToken,
      fetch: globalThis.fetch,
    };

    const createResult = await call(humanDependencies, {
      operationId: "project.create",
      body: { name: "auth-test-project" },
    });
    assert.equal(createResult.status, 200);
    assert.ok(createResult.ok);
    projectId = (createResult.body as { id: string }).id;

    const bindResult = await call(humanDependencies, {
      operationId: "project.repositories",
      parameters: { id: projectId },
      body: { repositories: ["repo_a"] },
    });
    assert.equal(bindResult.status, 200);
    assert.ok(bindResult.ok);

    const registerResult = await call(humanDependencies, {
      operationId: "actor.register",
      body: { name: "test-harness" },
    });
    assert.equal(registerResult.status, 200);
    assert.ok(registerResult.ok);
    harnessToken = (registerResult.body as { token: string }).token;

    harnessDependencies = {
      baseUrl: `http://127.0.0.1:${port}`,
      token: harnessToken,
      fetch: globalThis.fetch,
    };
  });

  after(async () => {
    if (daemon) {
      daemon.kill();
      await daemon.exited();
    }
    if (home) {
      home.dispose();
    }
  });

  it("project.nodes answers 200 to a harness token", async () => {
    const result = await call(harnessDependencies!, {
      operationId: "project.nodes",
      parameters: { id: projectId },
    });
    assert.equal(result.status, 200);
    assert.ok(result.ok);
  });

  it("project.nodes answers 200 to the human token", async () => {
    const result = await call(humanDependencies!, {
      operationId: "project.nodes",
      parameters: { id: projectId },
    });
    assert.equal(result.status, 200);
    assert.ok(result.ok);
  });

  it("project.graph answers 403 actor-forbidden to a harness token", async () => {
    const result = await call(harnessDependencies!, {
      operationId: "project.graph",
      parameters: { id: projectId },
    });
    assert.equal(result.status, 403);
    assert.ok(!result.ok);
    assert.equal(result.code, "actor-forbidden");
    assert.ok(result.message.includes("project.graph"));
    assert.ok(result.message.includes("harness"));
  });

  it("project.graph answers 200 to the human token", async () => {
    const result = await call(humanDependencies!, {
      operationId: "project.graph",
      parameters: { id: projectId },
    });
    assert.equal(result.status, 200);
    assert.ok(result.ok);
  });
});
