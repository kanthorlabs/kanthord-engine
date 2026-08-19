import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { call } from "./cli/client.ts";
import { registry } from "./http/contract/registry.ts";
import { KANTHORD_VERSION } from "./domain/version.ts";
import { bootstrapActorId } from "./domain/actor.ts";
import { createTemporaryHome } from "../test/helpers/home.ts";
import type { TemporaryHome } from "../test/helpers/home.ts";
import { launchDaemon } from "../test/helpers/daemon.ts";
import type { DaemonProcess } from "../test/helpers/daemon.ts";
import { runCli } from "../test/helpers/cli.ts";
import { reservePort } from "../test/helpers/port.ts";

const byBytes = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

// EPIC 018 Story 14 added the three claim routes; Story 17 binds them in
// main.ts and adds their fixture rows, so the pending list is empty.
// EPIC 019 Story 18 routes node.report; Story 19 binds it in main.ts and
// adds its fixture row, so the pending list is empty again.
const pending = [] as const;

const MISSING_ID = "01JZZZZZZZZZZZZZZZZZZZZZZZ";
const missing = (prefix: string): string => `${prefix}_${MISSING_ID}`;
const HARNESS_ID = "actor_01HZY8QF3M4N5P6R7S8T9V0W1X";

// Reserved and immediately closed, so the git subprocess meets a refused
// connection and never leaves the machine.
const deadUrl = `http://127.0.0.1:${await reservePort()}/dead.git`;

const stripStarted = (output: string): string =>
  output
    .split("\n")
    .filter((line) => !line.startsWith("kanthord: started "))
    .join("\n");

type Fixture = Readonly<{
  parameters?: Readonly<Record<string, string>>;
  body?: unknown;
  expect: number | "any-but-501";
}>;

let home: TemporaryHome | undefined;
let daemon: DaemonProcess | undefined;
let port = 0;
let statusBeforeRun = "";

const fixtures: Readonly<Record<string, Fixture>> = {
  "actor.register": { body: { name: "worker-a" }, expect: 200 },
  "actor.list": { expect: 200 },
  "actor.show": { parameters: { id: missing("actor") }, expect: 404 },
  "actor.revoke": { parameters: { id: missing("actor") }, expect: 404 },
  "actor.rotate": { parameters: { id: missing("actor") }, expect: 404 },
  "system.health": { expect: 200 },
  "system.db": { expect: 200 },
  "system.status": { expect: 200 },
  "provider.catalog": { expect: 200 },
  "provider.inspect": {
    body: {
      provider: "openai",
      baseUrl: null,
      apiKey: "sk-test",
    },
    expect: 400,
  },
  "provider.list": { expect: 200 },
  "provider.register": {
    body: {
      name: "provider-a",
      kind: "llm",
      payload: {
        provider: "openai",
        apiKey: "sk-test",
        defaultModel: "gpt-4o",
        baseUrl: null,
      },
    },
    expect: 200,
  },
  "provider.show": { parameters: { id: missing("provider") }, expect: 404 },
  "provider.rename": {
    parameters: { id: missing("provider") },
    body: { name: "renamed" },
    expect: 404,
  },
  "provider.setDefault": {
    parameters: { id: missing("provider") },
    expect: 404,
  },
  "provider.remove": {
    parameters: { id: missing("provider") },
    expect: 404,
  },
  "repository.list": { expect: 200 },
  "repository.show": {
    parameters: { id: missing("repository") },
    expect: 404,
  },
  "repository.inspect": {
    body: { remoteUrl: deadUrl, credentialId: missing("provider") },
    expect: "any-but-501",
  },
  "repository.register": {
    body: {
      name: "dead",
      remoteUrl: deadUrl,
      credentialId: missing("provider"),
      upstreamBranch: "main",
      landingBranch: "main",
      publishRef: "refs/heads/main",
      hostFingerprint: null,
    },
    expect: "any-but-501",
  },
  "project.create": { body: { name: "kanthord-verify" }, expect: 200 },
  "project.list": { expect: 200 },
  "project.show": { parameters: { id: missing("project") }, expect: 404 },
  "project.status": { parameters: { id: missing("project") }, expect: 404 },
  "project.repositories": {
    parameters: { id: missing("project") },
    body: { repositories: [] },
    expect: 404,
  },
  "plan.validate": {
    parameters: { id: missing("project") },
    body: {
      fromRevision: null,
      documents: [{ path: "plan.md", content: "# plan" }],
    },
    expect: 404,
  },
  "plan.import": {
    parameters: { id: missing("project") },
    body: {
      fromRevision: null,
      importId: "import-1",
      documents: [{ path: "plan.md", content: "# plan" }],
      choices: [],
      validatedRevision: null,
      documentsHash: `sha256:${"0".repeat(64)}`,
    },
    expect: 404,
  },
  "plan.export": { parameters: { id: missing("project") }, expect: 404 },
  "plan.revisions": { parameters: { id: missing("project") }, expect: 404 },
  "node.list": { expect: 200 },
  "node.show": { parameters: { id: missing("node") }, expect: 404 },
  "node.claim": {
    parameters: { id: missing("node") },
    body: {},
    expect: 404,
  },
  "node.heartbeat": {
    parameters: { id: missing("node") },
    body: { fence: 1 },
    expect: 404,
  },
  "node.release": {
    parameters: { id: missing("node") },
    body: { fence: 1 },
    expect: 404,
  },
  "node.report": {
    parameters: { id: missing("node") },
    body: { report: "accepted", fence: 1, objectId: "a".repeat(40) },
    expect: 404,
  },
  "node.unblock": {
    parameters: { id: missing("node") },
    expect: 404,
  },
  "node.create": {
    parameters: { id: missing("project") },
    body: {
      fromRevision: null,
      node: {
        kind: "initiative",
        title: "Do the work",
        instruction: "Do the initiative work.\n",
        worker: null,
        dependsOn: [],
      },
    },
    expect: 404,
  },
  "node.update": {
    parameters: { id: missing("node") },
    body: {
      fromRevision: "revision_00000000000000000000000000",
      node: {
        kind: "task",
        title: "Do the work",
        parentId: missing("objective"),
        instruction: "Do the task work.\n",
        acceptance: "## Acceptance criteria\n- it works\n",
        worker: null,
        dependsOn: [],
      },
    },
    expect: 404,
  },
  "node.delete": {
    parameters: { id: missing("node") },
    body: { fromRevision: "revision_00000000000000000000000000" },
    expect: 404,
  },
  "edge.list": { parameters: { id: missing("project") }, expect: 404 },
  "event.list": { expect: 200 },
  "blob.show": {
    parameters: { hash: `sha256:${"0".repeat(64)}` },
    expect: 404,
  },
};

const clientDependencies = () => ({
  baseUrl: `http://127.0.0.1:${port}`,
  token: "test-token",
  fetch: globalThis.fetch,
});

const statusArgs = (): readonly string[] => [
  "--base-url",
  `http://127.0.0.1:${port}`,
  "--token",
  "test-token",
];

describe("src/main.test", () => {
  before(async () => {
    home = createTemporaryHome();
    try {
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
    } catch (error) {
      home.dispose();
      home = undefined;
      throw error;
    }
  });

  after(async () => {
    if (daemon !== undefined) {
      daemon.kill("SIGTERM");
      await daemon.exited();
    }
    if (home !== undefined) {
      home.dispose();
    }
  });

  it("every routed operation answers and none resolves to the shared 501 handler", async () => {
    const routed = registry
      .filter((entry) => entry.status === "routed")
      .map((entry) => entry.operationId);
    const covered = Object.keys(fixtures);

    assert.deepEqual(
      [...covered].sort(byBytes),
      routed
        .filter((id) => !(pending as readonly string[]).includes(id))
        .sort(byBytes),
    );

    for (const [operationId, fixture] of Object.entries(fixtures)) {
      const result = await call(clientDependencies(), {
        operationId,
        parameters: fixture.parameters,
        body: fixture.body,
      });

      assert.notEqual(result.status, 501, `${operationId} answered 501`);
      if (!result.ok) {
        assert.notEqual(
          result.code,
          "internal-error",
          `${operationId} answered internal-error`,
        );
      }
      if (typeof fixture.expect === "number") {
        assert.equal(
          result.status,
          fixture.expect,
          `${operationId} expected status ${fixture.expect}`,
        );
      }
    }
  });

  it("no routed operation is left unbound", () => {
    const residue = registry
      .filter((entry) => entry.status === "routed")
      .map((entry) => entry.operationId)
      .filter((id) => !(id in fixtures))
      .sort(byBytes);
    assert.deepEqual(residue, [...pending].sort(byBytes));
  });

  it("the production handler map implements node.report", async () => {
    const result = await call(clientDependencies(), {
      operationId: "node.report",
      parameters: { id: missing("node") },
      body: { report: "accepted", fence: 1, objectId: "a".repeat(40) },
    });

    assert.notEqual(
      result.status,
      501,
      "an unbound node.report answers 501 through the dispatch fallback",
    );
  });

  it("kanthord status answers against the started daemon", async () => {
    const result = await runCli({ args: ["status", ...statusArgs()] });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^kanthord: version /m);
    assert.match(result.stdout, /^kanthord: bind /m);
    assert.match(result.stdout, /^kanthord: health (ok|degraded)$/m);
    statusBeforeRun = result.stdout;
  });

  it("kanthord run exits 220 with not-implemented and writes no stdout", async () => {
    const result = await runCli({
      args: ["run", "--project", missing("project"), ...statusArgs()],
    });

    assert.equal(result.code, 220);
    assert.match(result.stderr, /^kanthord: not-implemented: /);
    assert.equal(result.stdout, "");
  });

  it("kanthord run leaves kanthord status unchanged", async () => {
    const after = await runCli({ args: ["status", ...statusArgs()] });

    assert.equal(after.code, 0);
    assert.equal(stripStarted(after.stdout), stripStarted(statusBeforeRun));
  });

  it("the daemon and the CLI report one version", async () => {
    const version = await runCli({ args: ["--version"] });

    assert.equal(version.code, 0);
    assert.equal(version.stdout.trim(), KANTHORD_VERSION);

    const versionLine = statusBeforeRun.match(/^kanthord: version (\S+)$/m);
    assert.ok(versionLine !== null);
    const reported = versionLine[1];
    assert.ok(reported !== undefined);
    assert.equal(reported, KANTHORD_VERSION);
  });

  it("the daemon writes no internal-error and no recovery line", () => {
    const stderrText = daemon!.stderr();

    assert.equal(stderrText.includes("kanthord: internal-error:"), false);
    assert.equal(stderrText.includes("kanthord: recovery:"), false);
  });

  it("a provider.register call through the configured token appends an event that names the bootstrap actor", async () => {
    const database = new DatabaseSync(join(home!.path, "kanthord.db"));
    try {
      const countEvents = (): number =>
        (
          database.prepare("SELECT COUNT(*) AS c FROM event").get() as {
            c: number;
          }
        ).c;
      const before = countEvents();
      const result = await call(clientDependencies(), {
        operationId: "provider.register",
        body: {
          name: "attribution-a",
          kind: "llm",
          payload: {
            provider: "openai",
            apiKey: "sk-test",
            defaultModel: "gpt-4o",
            baseUrl: null,
          },
        },
      });
      assert.equal(result.status, 200);
      assert.equal(countEvents(), before + 1);
      const row = database
        .prepare(
          "SELECT type, actor_id, actor_kind FROM event ORDER BY id DESC LIMIT 1",
        )
        .get() as { type: string; actor_id: string; actor_kind: string };
      assert.equal(row.type, "provider.registered");
      assert.equal(row.actor_id, bootstrapActorId);
      assert.equal(row.actor_kind, "human");
      assert.notEqual(row.actor_id, "ulrich");
    } finally {
      database.close();
    }
  });

  it("a provider.register call through a harness token answers 403 and appends no event", async () => {
    const database = new DatabaseSync(join(home!.path, "kanthord.db"));
    try {
      const countEvents = (): number =>
        (
          database.prepare("SELECT COUNT(*) AS c FROM event").get() as {
            c: number;
          }
        ).c;
      const registered = await call(clientDependencies(), {
        operationId: "actor.register",
        body: { name: "harness-b" },
      });
      assert.equal(registered.status, 200);
      assert.ok(registered.ok, "the harness registration must succeed");
      const harnessToken = (registered.body as { token: string }).token;
      assert.equal(typeof harnessToken, "string");

      const before = countEvents();
      const refused = await call(
        { ...clientDependencies(), token: harnessToken },
        {
          operationId: "provider.register",
          body: {
            name: "attribution-b",
            kind: "llm",
            payload: {
              provider: "openai",
              apiKey: "sk-test",
              defaultModel: "gpt-4o",
              baseUrl: null,
            },
          },
        },
      );
      assert.equal(refused.status, 403);
      if (!refused.ok) {
        assert.equal(refused.code, "actor-forbidden");
      }
      assert.equal(countEvents(), before);
    } finally {
      database.close();
    }
  });

  it("main.ts binds no handler to the configured actor name and keeps the four daemon bindings", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "./main.ts"),
      "utf8",
    );
    const handlersRegion = source.slice(
      source.indexOf("const handlers"),
      source.indexOf("const app = createApp"),
    );
    assert.equal(
      (handlersRegion.match(/actor: settings\.actor/g) ?? []).length,
      0,
      "no handler may take the configured actor name",
    );
    assert.equal(
      (source.match(/settings\.actor/g) ?? []).length,
      1,
      "settings.actor keeps exactly one job: the bootstrap row name",
    );
    assert.equal(
      (source.match(/actor: "daemon"/g) ?? []).length,
      4,
      "the four startup steps keep their daemon attribution",
    );
  });

  it("main.ts mints one instance identity and passes it to readiness", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "./main.ts"),
      "utf8",
    );
    assert.equal(
      source.split("ulid()").length - 1,
      1,
      "ulid() appears exactly once",
    );
    assert.equal(source.includes("const instanceId = ulid();"), true);
    assert.equal(
      source.includes("new DependencyReadiness({ events, instanceId })"),
      true,
    );
    assert.equal(source.includes("new SqlitePlanStore({ readiness })"), true);
    const events = source.indexOf("new SqliteEventLog");
    const readiness = source.indexOf("new DependencyReadiness");
    const plan = source.indexOf("new SqlitePlanStore");
    assert.notEqual(events, -1);
    assert.notEqual(readiness, -1);
    assert.notEqual(plan, -1);
    assert.ok(events < readiness, "events before readiness");
    assert.ok(readiness < plan, "readiness before plan");
    assert.equal(
      (source.match(/actor: "daemon"/g) ?? []).length,
      4,
      "the four startup steps keep their daemon attribution",
    );
  });

  it("the daemon stops cleanly on SIGTERM and releases the home lock", async () => {
    daemon!.kill("SIGTERM");
    const exit = await daemon!.exited();

    assert.equal(exit.code, 0);
    assert.equal(daemon!.stderr().endsWith("kanthord: stopped\n"), true);
    assert.equal(daemon!.stderr().includes("kanthord: shutdown: "), false);

    const migrated = await runCli({
      args: ["db", "migrate", "--home", home!.path],
    });
    assert.equal(migrated.code, 0, migrated.stderr);
  });

  it("ensureBootstrapActor runs after the migration gate and before recoverHome", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "./main.ts"),
      "utf8",
    );
    const gate = source.indexOf("assertMigrated(");
    const ensure = source.indexOf("ensureBootstrapActor(");
    const recover = source.indexOf("recoverHome(");

    assert.notEqual(gate, -1, "assertMigrated call not found");
    assert.notEqual(ensure, -1, "ensureBootstrapActor call not found");
    assert.notEqual(recover, -1, "recoverHome call not found");
    assert.ok(
      ensure > gate,
      "ensureBootstrapActor must run after assertMigrated",
    );
    assert.ok(
      ensure < recover,
      "ensureBootstrapActor must run before recoverHome",
    );
  });

  it("a daemon whose configured actor names a registered harness refuses to start", async () => {
    const refusalHome = createTemporaryHome();
    try {
      const refusalPort = await reservePort();
      const migrated = await runCli({
        args: ["db", "migrate", "--home", refusalHome.path],
      });
      assert.equal(migrated.code, 0, migrated.stderr);

      const database = new DatabaseSync(join(refusalHome.path, "kanthord.db"));
      database
        .prepare(
          "INSERT INTO actor (id, kind, name, token_sha256, registered_by, created_at, revoked_at, revoked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          HARNESS_ID,
          "harness",
          "harness-a",
          new Uint8Array(32),
          bootstrapActorId,
          1700000000000,
          null,
          null,
        );
      database.close();

      const configPath = refusalHome.writeConfig({
        actor: "harness-a",
        http: {
          port: refusalPort,
          allowedHosts: [`127.0.0.1:${refusalPort}`],
        },
      });
      const refusing = launchDaemon({ configPath });
      const exit = await Promise.race([
        refusing.exited(),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            refusing.kill("SIGKILL");
            reject(
              new Error(
                "the daemon did not exit: ensureBootstrapActor did not refuse startup",
              ),
            );
          }, 10000);
        }),
      ]);
      assert.notEqual(exit.code, 0);
      assert.equal(refusing.stderr().includes(HARNESS_ID), true);
    } finally {
      refusalHome.dispose();
    }
  });
});
