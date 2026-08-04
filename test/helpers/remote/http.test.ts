import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  httpAcceptanceChecks,
  httpCredentials,
  httpWrongCredential,
  startHttpRemote,
} from "./http.ts";
import type { FixtureCredential } from "./http.ts";
import {
  fixtureObjectIds,
  pinnedGitConfigArguments,
  pinnedGitEnvironment,
  seedRepositories,
} from "./seed.ts";
import { resolveTools, toolTimeoutMilliseconds } from "./tools.ts";
import type { Tools } from "./tools.ts";

const spawnGuard = {
  timeout: toolTimeoutMilliseconds,
  killSignal: "SIGKILL" as const,
  maxBuffer: 8 * 1024 * 1024,
};

const execGit = promisify(execFile);

function basicHeader(credential: FixtureCredential): string {
  return (
    "Basic " +
    Buffer.from(`${credential.username}:${credential.token}`).toString("base64")
  );
}

async function createClientRepo(
  tools: Tools,
  env: Readonly<Record<string, string>>,
): Promise<string> {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kanthord-http-client-"));
  await execGit(
    tools.paths.git,
    [...pinnedGitConfigArguments, "init", "--template=", dir],
    { env, encoding: "utf8", ...spawnGuard },
  );
  return dir;
}

async function runGit(
  tools: Tools,
  dir: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<string> {
  const { stdout } = await execGit(
    tools.paths.git,
    [...pinnedGitConfigArguments, "-C", dir, ...args],
    { env, encoding: "utf8", ...spawnGuard },
  );
  return stdout.toString().trim();
}

describe("test/helpers/remote/http.test", () => {
  const tools = resolveTools({});

  it("reports a loopback port above 1024 with origin, url and authenticatedUrl built from it", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startHttpRemote(tools, seed);
    after(() => remote.dispose());

    assert.equal(typeof remote.port, "number");
    assert.ok(remote.port > 1024);
    assert.equal(remote.origin, `http://127.0.0.1:${remote.port}`);
    assert.equal(remote.url("fixture.git"), `${remote.origin}/fixture.git`);
    assert.equal(
      remote.authenticatedUrl("fixture.git", remote.credentials.reader),
      `http://reader:r-tok@127.0.0.1:${remote.port}/fixture.git`,
    );
  });

  it("exports the fixed reader, writer and wrong credentials", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startHttpRemote(tools, seed);
    after(() => remote.dispose());

    assert.deepEqual(httpCredentials, {
      reader: { username: "reader", token: "r-tok", write: false },
      writer: { username: "writer", token: "w-tok", write: true },
    });
    assert.deepEqual(httpWrongCredential, {
      username: "writer",
      token: "bad-tok",
      write: false,
    });
    assert.deepEqual(remote.credentials, httpCredentials);
    assert.deepEqual(remote.wrongCredential, httpWrongCredential);
  });

  it("answers the receive-pack matrix 401 for no header, wrong and reader, and 200 for writer", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startHttpRemote(tools, seed);
    after(() => remote.dispose());

    const endpoint = `${remote.url("fixture.git")}/info/refs?service=git-receive-pack`;
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal(
      (
        await fetch(endpoint, {
          headers: { authorization: basicHeader(remote.wrongCredential) },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(endpoint, {
          headers: { authorization: basicHeader(remote.credentials.reader) },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(endpoint, {
          headers: { authorization: basicHeader(remote.credentials.writer) },
        })
      ).status,
      200,
    );
  });

  it("serves the upload-pack advertisement to no credential, a wrong credential and the reader", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startHttpRemote(tools, seed);
    after(() => remote.dispose());

    const endpoint = `${remote.url("fixture.git")}/info/refs?service=git-upload-pack`;
    assert.equal((await fetch(endpoint)).status, 200);
    assert.equal(
      (
        await fetch(endpoint, {
          headers: { authorization: basicHeader(remote.wrongCredential) },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(endpoint, {
          headers: { authorization: basicHeader(remote.credentials.reader) },
        })
      ).status,
      200,
    );
  });

  it("spawns no CGI for the three refused write requests and logs them with spawnedCgi false", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startHttpRemote(tools, seed);
    after(() => remote.dispose());

    const endpoint = `${remote.url("fixture.git")}/info/refs?service=git-receive-pack`;
    await fetch(endpoint);
    await fetch(endpoint, {
      headers: { authorization: basicHeader(remote.wrongCredential) },
    });
    await fetch(endpoint, {
      headers: { authorization: basicHeader(remote.credentials.reader) },
    });

    assert.equal(remote.cgiSpawnCount(), 0);
    const records = remote.requestLog();
    assert.equal(records.length, 3);
    for (const record of records) {
      assert.equal(record.spawnedCgi, false);
    }
  });

  it("changes nothing on the fixture across the receive-pack matrix", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startHttpRemote(tools, seed);
    after(() => remote.dispose());

    const refsBefore = seed.git("fixture.git", [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ]);
    const objectsBefore = seed.git("fixture.git", ["count-objects", "-v"]);

    const endpoint = `${remote.url("fixture.git")}/info/refs?service=git-receive-pack`;
    await fetch(endpoint);
    await fetch(endpoint, {
      headers: { authorization: basicHeader(remote.wrongCredential) },
    });
    await fetch(endpoint, {
      headers: { authorization: basicHeader(remote.credentials.reader) },
    });
    await fetch(endpoint, {
      headers: { authorization: basicHeader(remote.credentials.writer) },
    });

    assert.equal(
      seed.git("fixture.git", [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
      ]),
      refsBefore,
    );
    assert.equal(
      seed.git("fixture.git", ["count-objects", "-v"]),
      objectsBefore,
    );
  });

  it("fetches refs/remotes/origin/HEAD and refs/remotes/origin/main and no refs/heads or refs/tags with --no-tags", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startHttpRemote(tools, seed);
    after(() => remote.dispose());

    const env = { ...pinnedGitEnvironment, PATH: tools.execPath };
    const client = await createClientRepo(tools, env);
    after(() => fs.rmSync(client, { recursive: true, force: true }));

    await runGit(
      tools,
      client,
      [
        "remote",
        "add",
        "origin",
        remote.authenticatedUrl("fixture.git", remote.credentials.reader),
      ],
      env,
    );
    await runGit(
      tools,
      client,
      ["fetch", "--no-tags", "--prune", "origin"],
      env,
    );

    const refs: Record<string, string> = {};
    for (const line of (
      await runGit(
        tools,
        client,
        ["for-each-ref", "--format=%(refname) %(objectname)"],
        env,
      )
    ).split("\n")) {
      if (line === "") continue;
      const [name, objectName] = line.split(" ");
      assert.ok(name !== undefined);
      assert.ok(objectName !== undefined);
      refs[name] = objectName;
    }
    assert.equal(refs["refs/remotes/origin/HEAD"], fixtureObjectIds.commit2);
    assert.equal(refs["refs/remotes/origin/main"], fixtureObjectIds.commit2);
    assert.equal(
      Object.keys(refs).some((name) => /^refs\/heads\//.test(name)),
      false,
    );
    assert.equal(
      Object.keys(refs).some((name) => /^refs\/tags\//.test(name)),
      false,
    );
  });

  it("reports ref: refs/heads/main for HEAD through ls-remote --symref", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startHttpRemote(tools, seed);
    after(() => remote.dispose());

    const env = { ...pinnedGitEnvironment, PATH: tools.execPath };
    const { stdout } = await execGit(
      tools.paths.git,
      [
        ...pinnedGitConfigArguments,
        "ls-remote",
        "--symref",
        remote.url("fixture.git"),
        "HEAD",
      ],
      { env, encoding: "utf8", ...spawnGuard },
    );
    const output = stdout.toString();
    assert.ok(output.includes(`ref: refs/heads/main\tHEAD`));
    assert.ok(output.includes(`${fixtureObjectIds.commit2}\tHEAD`));
  });

  it("ignores a hostile HOME .gitconfig while the pin holds and honors it without the pin", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startHttpRemote(tools, seed);
    after(() => remote.dispose());

    const hostileHome = fs.mkdtempSync(join(os.tmpdir(), "kanthord-hostile-"));
    after(() => fs.rmSync(hostileHome, { recursive: true, force: true }));
    fs.writeFileSync(
      join(hostileHome, ".gitconfig"),
      "[http]\n\textraHeader = X-Hostile: yes\n[credential]\n\thelper = /nonexistent/helper\n",
    );

    const url = remote.authenticatedUrl(
      "fixture.git",
      remote.credentials.reader,
    );
    const pinnedEnv = {
      ...pinnedGitEnvironment,
      PATH: tools.execPath,
      HOME: hostileHome,
    };
    const client = await createClientRepo(tools, pinnedEnv);
    after(() => fs.rmSync(client, { recursive: true, force: true }));
    await runGit(tools, client, ["remote", "add", "origin", url], pinnedEnv);
    await runGit(
      tools,
      client,
      ["fetch", "--no-tags", "--prune", "origin"],
      pinnedEnv,
    );

    const pinnedRecords = remote.requestLog();
    assert.equal(pinnedRecords.length > 0, true);
    assert.equal(
      pinnedRecords.some((record) => "x-hostile" in record.headers),
      false,
    );

    const { GIT_CONFIG_GLOBAL: _droppedGlobal, ...controlBase } =
      pinnedGitEnvironment;
    const controlEnv = {
      ...controlBase,
      PATH: tools.execPath,
      HOME: hostileHome,
    };
    await runGit(
      tools,
      client,
      ["fetch", "--no-tags", "--prune", "origin"],
      controlEnv,
    );

    const allRecords = remote.requestLog();
    assert.equal(
      allRecords.some((record) => record.headers["x-hostile"] === "yes"),
      true,
    );
  });

  it("exports the four acceptance checks with the exact names in order", () => {
    assert.equal(httpAcceptanceChecks.length, 4);
    assert.deepEqual(
      httpAcceptanceChecks.map((check) => check.name),
      [
        "http: HEAD symref discovery",
        "http: fetch writes the tracking ref",
        "http: receive-pack refuses a missing and a wrong credential",
        "http: receive-pack admits a write credential",
      ],
    );
  });

  it("passes every acceptance check against a live handle", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startHttpRemote(tools, seed);
    after(() => remote.dispose());

    for (const check of httpAcceptanceChecks) {
      await check.run(remote);
    }
  });

  it("records the swallowed CGI-stdin write error on the request record instead of discarding it silently", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());

    const stubDir = fs.mkdtempSync(
      join(os.tmpdir(), "kanthord-http-stub-cgi-"),
    );
    after(() => fs.rmSync(stubDir, { recursive: true, force: true }));
    const stubBackend = join(stubDir, "git-http-backend");
    fs.writeFileSync(stubBackend, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(stubBackend, 0o755);

    const stubTools: Tools = { ...tools, httpBackend: stubBackend };
    const remote = await startHttpRemote(stubTools, seed);
    after(() => remote.dispose());

    const before = remote.requestLog().length;
    const pumpDeadline = Date.now() + 1000;

    const currentRecord = (): Record<string, unknown> | undefined => {
      const records = remote.requestLog();
      return records[records.length - 1] as unknown as
        Record<string, unknown> | undefined;
    };

    await new Promise<void>((resolvePost) => {
      const request = http.request(
        {
          hostname: "127.0.0.1",
          port: remote.port,
          method: "POST",
          path: "/fixture.git/git-receive-pack",
          agent: false,
          headers: {
            authorization: basicHeader(remote.credentials.writer),
            "content-type": "application/x-git-receive-pack-request",
          },
        },
        (response) => {
          response.resume();
        },
      );
      request.on("error", () => undefined);

      const chunk = Buffer.alloc(64 * 1024, 1);
      const pump = (): void => {
        const record = currentRecord();
        const gotStreamError =
          remote.requestLog().length > before &&
          record?.["streamError"] !== undefined;
        if (gotStreamError || Date.now() > pumpDeadline) {
          try {
            request.end();
          } catch {
            // already ended by the EPIPE this test is forcing
          }
          resolvePost();
          return;
        }
        try {
          request.write(chunk);
        } catch {
          // the client side sees its own half of the same broken pipe
        }
        setTimeout(pump, 5);
      };
      pump();
    });

    const deadline = Date.now() + 500;
    let records = remote.requestLog();
    let record = currentRecord();
    while (
      (records.length === before || record?.["streamError"] === undefined) &&
      Date.now() < deadline
    ) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      records = remote.requestLog();
      record = currentRecord();
    }

    assert.equal(records.length, before + 1);
    assert.ok(record !== undefined, "expected a request record to exist");
    assert.equal(record["spawnedCgi"], true);

    const serialized = JSON.stringify(record).toLowerCase();
    assert.ok(
      serialized.includes("epipe"),
      `expected the request record to carry the swallowed stream-error message, got ${JSON.stringify(record)}`,
    );

    const stillServing = await fetch(
      `${remote.url("fixture.git")}/info/refs?service=git-upload-pack`,
    );
    assert.equal(stillServing.status, 200);
  });

  it("records a non-zero status and a reason when the CGI child fails to spawn", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const badTools: Tools = {
      ...tools,
      httpBackend: join(tools.execPath, "kanthord-nonexistent-http-backend"),
    };
    const remote = await startHttpRemote(badTools, seed);
    after(() => remote.dispose());

    const before = remote.requestLog().length;

    const endpoint = `${remote.url("fixture.git")}/info/refs?service=git-receive-pack`;
    const response = await fetch(endpoint, {
      headers: { authorization: basicHeader(remote.credentials.writer) },
    });
    await response.arrayBuffer();

    const deadline = Date.now() + 5000;
    let records = remote.requestLog();
    let record = records[records.length - 1] as unknown as
      Record<string, unknown> | undefined;
    while (
      (records.length === before || record?.["status"] === 0) &&
      Date.now() < deadline
    ) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      records = remote.requestLog();
      record = records[records.length - 1] as unknown as
        Record<string, unknown> | undefined;
    }

    assert.equal(records.length, before + 1);
    assert.ok(record !== undefined, "expected a request record to exist");
    assert.equal(record["spawnedCgi"], true);
    assert.notEqual(
      record["status"],
      0,
      `expected the record to expose the failed CGI's status, got ${JSON.stringify(record)}`,
    );

    const serialized = JSON.stringify(record).toLowerCase();
    assert.ok(
      serialized.includes("enoent") ||
        serialized.includes("no such file") ||
        serialized.includes("spawn"),
      `expected the request record to carry the spawn failure reason, got ${JSON.stringify(record)}`,
    );
  });

  it("dispose resolves and the origin rejects a fetch afterwards", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startHttpRemote(tools, seed);

    await remote.dispose();
    await assert.rejects(
      fetch(`${remote.url("fixture.git")}/info/refs?service=git-upload-pack`),
    );
  });
});
