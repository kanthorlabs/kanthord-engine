import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { call } from "./cli/client.ts";
import { registry } from "./http/contract/registry.ts";
import { KANTHORD_VERSION } from "./domain/version.ts";
import { createTemporaryHome } from "../test/helpers/home.ts";
import type { TemporaryHome } from "../test/helpers/home.ts";
import { launchDaemon } from "../test/helpers/daemon.ts";
import type { DaemonProcess } from "../test/helpers/daemon.ts";
import { runCli } from "../test/helpers/cli.ts";
import { reservePort } from "../test/helpers/port.ts";

const byBytes = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

// EPIC 010 has bound every routed operation; nothing is pending.
const pending = [] as const;

const MISSING_ID = "01JZZZZZZZZZZZZZZZZZZZZZZZ";
const missing = (prefix: string): string => `${prefix}_${MISSING_ID}`;

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
  "system.health": { expect: 200 },
  "system.db": { expect: 200 },
  "system.status": { expect: 200 },
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
});
