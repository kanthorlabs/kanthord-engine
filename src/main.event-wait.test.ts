import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { request as httpRequest } from "node:http";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { eventListResponse } from "./http/contract/event.ts";
import { createTemporaryHome } from "../test/helpers/home.ts";
import type { TemporaryHome } from "../test/helpers/home.ts";
import { launchDaemon } from "../test/helpers/daemon.ts";
import type { DaemonProcess } from "../test/helpers/daemon.ts";
import { runCli } from "../test/helpers/cli.ts";
import { reservePort } from "../test/helpers/port.ts";

const humanToken = "test-token";

type RawResponse = Readonly<{
  status: number;
  text: string;
}>;

function makeRawRequest(resolvedPort: number) {
  return async function rawRequest(
    method: "GET" | "POST",
    path: string,
    options: Readonly<{ body?: unknown }> = {},
  ): Promise<RawResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${humanToken}`,
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const response = await globalThis.fetch(
      `http://127.0.0.1:${resolvedPort}${path}`,
      { method, headers, body },
    );
    return {
      status: response.status,
      text: await response.text(),
    };
  };
}

function eventRows(database: DatabaseSync): readonly Record<string, unknown>[] {
  return database
    .prepare("SELECT * FROM event ORDER BY id ASC")
    .all() as readonly Record<string, unknown>[];
}

function dataVersion(database: DatabaseSync): number {
  return (
    database.prepare("PRAGMA data_version").get() as {
      data_version: number;
    }
  ).data_version;
}

function heldRequest(
  resolvedPort: number,
  path: string,
): Readonly<{
  answered: Promise<RawResponse>;
  sent: Promise<void>;
}> {
  let respond!: (value: RawResponse) => void;
  const answered = new Promise<RawResponse>((resolve) => {
    respond = resolve;
  });
  let written!: () => void;
  const sent = new Promise<void>((resolve) => {
    written = resolve;
  });
  const request = httpRequest(
    {
      host: "127.0.0.1",
      port: resolvedPort,
      path,
      headers: { Authorization: `Bearer ${humanToken}` },
      agent: false,
    },
    (response) => {
      let text = "";
      response.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      response.on("end", () => {
        respond({ status: response.statusCode ?? 0, text });
      });
    },
  );
  request.on("finish", written);
  request.end();
  return { answered, sent };
}

describe("src/main.event-wait.test", () => {
  let home: TemporaryHome | undefined;
  let daemon: DaemonProcess | undefined;
  let port = 0;
  let rawRequest: ReturnType<typeof makeRawRequest>;

  before(async () => {
    home = createTemporaryHome();
    port = await reservePort();
    const configPath = home.writeConfig({
      http: {
        port,
        allowedHosts: [`127.0.0.1:${port}`],
        event: { maxWait: 5 },
      },
    });
    const migrated = await runCli({
      args: ["db", "migrate", "--home", home.path],
    });
    assert.equal(migrated.code, 0, migrated.stderr);
    daemon = launchDaemon({ configPath });
    await daemon.ready();
    rawRequest = makeRawRequest(port);
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

  it("wait=61 is refused by the shipped schema", async () => {
    const response = await rawRequest("GET", "/v1/event?wait=61");

    assert.equal(response.status, 400);
    const body = JSON.parse(response.text) as { error: { code: string } };
    assert.equal(body.error.code, "invalid-request");
  });

  it("a wait above the configured maximum is refused through the real composition root", async () => {
    const response = await rawRequest("GET", "/v1/event?wait=30");

    assert.equal(response.status, 400);
    const body = JSON.parse(response.text) as { error: { code: string } };
    assert.equal(body.error.code, "invalid-request");
  });

  it("an immediate answer still comes from the real root", async () => {
    const response = await rawRequest("GET", "/v1/event?wait=0");

    assert.equal(response.status, 200);
    assert.equal(
      eventListResponse.safeParse(JSON.parse(response.text)).success,
      true,
    );
  });

  it("a waited call that elapses writes nothing", async () => {
    assert.ok(home !== undefined);

    const database = new DatabaseSync(join(home.path, "kanthord.db"));
    try {
      const beforeRows = eventRows(database);
      const beforeVersion = dataVersion(database);
      const order: string[] = [];

      const held = heldRequest(port, "/v1/event?wait=1");
      await held.sent;
      held.answered.then(
        () => {
          order.push("held");
        },
        () => {},
      );

      const barrier = await rawRequest("GET", "/v1/event?wait=0");
      assert.equal(barrier.status, 200);
      assert.deepEqual(order, []);

      const answered = await held.answered;
      assert.equal(answered.status, 200);
      assert.deepEqual(JSON.parse(answered.text), { events: [] });

      assert.deepEqual(eventRows(database), beforeRows);
      assert.equal(dataVersion(database), beforeVersion);
    } finally {
      database.close();
    }
  });

  it("a waited call that returns an event writes nothing beyond the delivered event", async () => {
    assert.ok(home !== undefined);

    const prepared = await rawRequest("POST", "/v1/actor", {
      body: { name: "wait-write-probe-base" },
    });
    assert.equal(prepared.status, 200);
    const listed = await rawRequest("GET", "/v1/event");
    assert.equal(listed.status, 200);
    const known = (
      JSON.parse(listed.text) as { events: readonly { id: string }[] }
    ).events;
    assert.ok(known.length > 0);
    const cursor = known[known.length - 1]!.id;

    const database = new DatabaseSync(join(home.path, "kanthord.db"));
    try {
      const beforeRows = eventRows(database);
      const order: string[] = [];

      const held = heldRequest(port, `/v1/event?wait=1&after=${cursor}`);
      await held.sent;
      held.answered.then(
        () => {
          order.push("held");
        },
        () => {},
      );

      const barrier = await rawRequest("GET", "/v1/event?wait=0");
      assert.equal(barrier.status, 200);
      assert.deepEqual(order, []);

      const seeded = await rawRequest("POST", "/v1/actor", {
        body: { name: "wait-write-probe-held" },
      });
      assert.equal(seeded.status, 200);
      const versionAfterSeed = dataVersion(database);

      const answered = await held.answered;
      assert.equal(answered.status, 200);
      const delivered = (
        JSON.parse(answered.text) as { events: readonly { id: string }[] }
      ).events;
      assert.ok(delivered.length > 0);
      for (const event of delivered) {
        assert.ok(event.id > cursor);
      }

      const afterRows = eventRows(database);
      assert.equal(afterRows.length, beforeRows.length + delivered.length);
      assert.deepEqual(afterRows.slice(0, beforeRows.length), beforeRows);
      const tailIds = afterRows
        .slice(beforeRows.length)
        .map((row) => row["id"])
        .sort();
      assert.deepEqual(tailIds, [...delivered.map((event) => event.id)].sort());
      assert.equal(dataVersion(database), versionAfterSeed);
    } finally {
      database.close();
    }
  });
});

describe("src/main.event-wait.test — shutdown does not wait for a waiter", () => {
  let home: TemporaryHome | undefined;
  let daemon: DaemonProcess | undefined;
  let port = 0;
  let rawRequest: ReturnType<typeof makeRawRequest>;

  before(async () => {
    home = createTemporaryHome();
    port = await reservePort();
    const configPath = home.writeConfig({
      http: {
        port,
        allowedHosts: [`127.0.0.1:${port}`],
        event: { maxWait: 30 },
      },
    });
    const migrated = await runCli({
      args: ["db", "migrate", "--home", home.path],
    });
    assert.equal(migrated.code, 0, migrated.stderr);
    daemon = launchDaemon({ configPath });
    await daemon.ready();
    rawRequest = makeRawRequest(port);
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

  it("shutdown answers a pending wait empty and exits without the wait elapsing", async () => {
    assert.ok(daemon !== undefined);

    let respond!: (value: RawResponse) => void;
    const answered = new Promise<RawResponse>((resolve) => {
      respond = resolve;
    });
    let written!: () => void;
    const sent = new Promise<void>((resolve) => {
      written = resolve;
    });
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/event?wait=30",
        headers: { Authorization: `Bearer ${humanToken}` },
        agent: false,
      },
      (response) => {
        let text = "";
        response.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
        });
        response.on("end", () => {
          respond({ status: response.statusCode ?? 0, text });
        });
      },
    );
    request.on("finish", written);
    request.end();
    await sent;

    const barrier = await new Promise<RawResponse>((resolve, reject) => {
      const barrierRequest = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/v1/event?wait=0",
          headers: { Authorization: `Bearer ${humanToken}` },
          agent: false,
        },
        (response) => {
          let text = "";
          response.on("data", (chunk: Buffer) => {
            text += chunk.toString("utf8");
          });
          response.on("end", () => {
            resolve({ status: response.statusCode ?? 0, text });
          });
        },
      );
      barrierRequest.on("error", reject);
      barrierRequest.end();
    });
    assert.equal(barrier.status, 200);

    const startedAt = Date.now();
    daemon.kill("SIGTERM");
    const exit = await daemon.exited();

    assert.ok(Date.now() - startedAt < 1000);
    assert.equal(exit.code, 0);

    const pending = await answered;
    assert.equal(pending.status, 200);
    assert.deepEqual(JSON.parse(pending.text), { events: [] });

    assert.equal(daemon.stderr().endsWith("kanthord: stopped\n"), true);
    assert.equal(daemon.stderr().includes("kanthord: shutdown: "), false);
  });
});
