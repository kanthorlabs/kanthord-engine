import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { call } from "./cli/client.ts";
import type { ClientDependencies } from "./cli/client.ts";
import { KANTHORD_VERSION } from "./domain/version.ts";
import { declaredCapabilities } from "./http/contract/capability.ts";
import { registry } from "./http/contract/registry.ts";
import { systemHealthResponse } from "./http/contract/system.ts";
import { createTemporaryHome } from "../test/helpers/home.ts";
import type { TemporaryHome } from "../test/helpers/home.ts";
import { launchDaemon } from "../test/helpers/daemon.ts";
import type { DaemonProcess } from "../test/helpers/daemon.ts";
import { runCli } from "../test/helpers/cli.ts";
import { reservePort } from "../test/helpers/port.ts";

type RawResponse = Readonly<{
  status: number;
  text: string;
  headers: Headers;
}>;

let home: TemporaryHome | undefined;
let daemon: DaemonProcess | undefined;
let port = 0;
let harnessToken = "";
const humanToken = "test-token";

async function rawRequest(
  method: "GET" | "POST",
  path: string,
  token: string,
  options: Readonly<{
    headers?: Readonly<Record<string, string>>;
    body?: unknown;
  }> = {},
): Promise<RawResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(options.headers ?? {}),
  };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await globalThis.fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body,
  });
  return {
    status: response.status,
    text: await response.text(),
    headers: response.headers,
  };
}

function clientDependencies(): ClientDependencies {
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token: humanToken,
    fetch: globalThis.fetch,
  };
}

describe("src/main.capability.test", () => {
  before(async () => {
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

    const registered = await call(clientDependencies(), {
      operationId: "actor.register",
      body: { name: "harness-capability" },
    });
    assert.equal(registered.status, 200);
    assert.ok(registered.ok);
    const token = (registered.body as { token: unknown }).token;
    if (typeof token !== "string" || token.length === 0) {
      assert.fail();
    }
    harnessToken = token;
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

  it("the production composition root serves the handshake", async () => {
    const response = await rawRequest("GET", "/v1/health", humanToken);
    assert.equal(response.status, 200);
    const body = JSON.parse(response.text) as {
      version: string;
      capabilities: readonly string[];
    };
    assert.equal(body.version, KANTHORD_VERSION);
    assert.deepEqual(body.capabilities, declaredCapabilities(registry));
    systemHealthResponse.parse(body);
  });

  it("the capability list is the expected list", async () => {
    const response = await rawRequest("GET", "/v1/health", humanToken);
    assert.equal(response.status, 200);
    const body = JSON.parse(response.text) as {
      capabilities: readonly string[];
    };
    assert.deepEqual(body.capabilities, [
      "external-drive",
      "per-node-write",
      "project-graph",
    ]);
  });

  it("a harness reads the identical handshake", async () => {
    const human = await rawRequest("GET", "/v1/health", humanToken);
    const harness = await rawRequest("GET", "/v1/health", harnessToken);
    assert.equal(human.status, 200);
    assert.equal(harness.status, 200);
    assert.equal(
      Buffer.compare(
        Buffer.from(human.text, "utf8"),
        Buffer.from(harness.text, "utf8"),
      ),
      0,
    );
  });

  it("a harness cannot read system.status", async () => {
    const response = await rawRequest("GET", "/v1/status", harnessToken);
    assert.equal(response.status, 403);
    const body = JSON.parse(response.text) as { error: { code: string } };
    assert.equal(body.error.code, "actor-forbidden");
  });

  it("the response does not vary by the client header", async () => {
    const responses = [
      await rawRequest("GET", "/v1/health", humanToken),
      await rawRequest("GET", "/v1/health", humanToken, {
        headers: { "X-Kanthord-Client": "0.0.1" },
      }),
      await rawRequest("GET", "/v1/health", humanToken, {
        headers: { "X-Kanthord-Client": "999.0.0" },
      }),
      await rawRequest("GET", "/v1/health", humanToken, {
        headers: { "X-Kanthord-Client": "not a version" },
      }),
    ];
    assert.equal(responses[0]?.status, 200);
    for (const response of responses.slice(1)) {
      assert.equal(response.status, 200);
      assert.equal(
        Buffer.compare(
          Buffer.from(responses[0]!.text, "utf8"),
          Buffer.from(response.text, "utf8"),
        ),
        0,
      );
    }
  });

  it("responses vary by Origin but not by X-Kanthord-Client", async () => {
    const responses = [
      await rawRequest("GET", "/v1/health", humanToken),
      await rawRequest("GET", "/v1/status", humanToken),
      await rawRequest("POST", "/v1/actor", humanToken, {
        body: { name: "vary-probe" },
      }),
    ];
    for (const response of responses) {
      const vary = response.headers.get("vary");
      if (vary === null) {
        assert.fail();
      }
      const lower = vary.toLowerCase();
      assert.match(lower, /origin/);
      assert.doesNotMatch(lower, /x-kanthord-client/);
    }
  });

  it("GET /v1/health writes nothing", async () => {
    assert.ok(home !== undefined);
    const database = new DatabaseSync(join(home.path, "kanthord.db"));
    try {
      const beforeEvents = JSON.stringify(
        database.prepare("SELECT * FROM event ORDER BY id ASC").all(),
      );
      const beforeDataVersion = (
        database.prepare("PRAGMA data_version").get() as {
          data_version: number;
        }
      ).data_version;
      const response = await rawRequest("GET", "/v1/health", humanToken);
      assert.equal(response.status, 200);
      const afterEvents = JSON.stringify(
        database.prepare("SELECT * FROM event ORDER BY id ASC").all(),
      );
      const afterDataVersion = (
        database.prepare("PRAGMA data_version").get() as {
          data_version: number;
        }
      ).data_version;
      assert.equal(afterEvents, beforeEvents);
      assert.equal(afterDataVersion, beforeDataVersion);
    } finally {
      database.close();
    }
  });
});
