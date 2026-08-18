import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  pollHealth,
  readinessDeadlineMilliseconds,
  readinessIntervalMilliseconds,
} from "./readiness.ts";
import { RunnerError } from "../errors.ts";
import type { HttpIssuer } from "../driver/index.ts";

const target = { token: "topology-token", allowedHost: "kanthord-daemon:7421" };

test("pollHealth requests GET /v1/health with both the Authorization and the Host headers set", async () => {
  const requests: Parameters<HttpIssuer>[0][] = [];
  const issue: HttpIssuer = async (request) => {
    requests.push(request);
    return { status: 200, body: "" };
  };

  await pollHealth(issue, target);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[0]?.path, "/v1/health");
  assert.equal(requests[0]?.headers.Authorization, `Bearer ${target.token}`);
  assert.equal(requests[0]?.headers.Host, target.allowedHost);
});

test("an issuer answering 503 twice then 200 resolves, and issued exactly three requests", async () => {
  let calls = 0;
  const issue: HttpIssuer = async () => {
    calls += 1;
    if (calls < 3) {
      return { status: 503, body: "not ready" };
    }
    return { status: 200, body: "ok" };
  };

  await pollHealth(issue, target);

  assert.equal(calls, 3);
});

test("an issuer rejecting twice with a connection error then answering 200 resolves, retrying rather than aborting on the first transport error", async () => {
  let calls = 0;
  const issue: HttpIssuer = async () => {
    calls += 1;
    if (calls < 3) {
      throw new Error("connect ECONNREFUSED 127.0.0.1:7421");
    }
    return { status: 200, body: "ok" };
  };

  await pollHealth(issue, target);

  assert.equal(calls, 3);
});

test("an issuer answering 503 forever rejects with assertion-failed, carrying the last status and body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });

  const issue: HttpIssuer = async () => ({
    status: 503,
    body: "still not ready",
  });

  const promise = pollHealth(issue, target);
  promise.catch(() => {});

  const ticks =
    Math.ceil(readinessDeadlineMilliseconds / readinessIntervalMilliseconds) +
    2;
  for (let index = 0; index < ticks; index += 1) {
    await t.mock.timers.tick(readinessIntervalMilliseconds);
  }

  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RunnerError);
    assert.equal(error.code, "assertion-failed");
    assert.equal(
      error.message,
      `the daemon was not healthy within ${readinessDeadlineMilliseconds}ms`,
    );
    const withDiagnostics = error as unknown as {
      lastStatus?: number;
      lastBody?: string;
    };
    assert.equal(withDiagnostics.lastStatus, 503);
    assert.equal(withDiagnostics.lastBody, "still not ready");
    return true;
  });
});

test("the scenario path contains no sleep: no file under scripts/e2e/lib other than readiness.ts and scenario/clock.ts contains setTimeout", () => {
  const libRoot = resolve(import.meta.dirname, "..");
  const readinessPath = join(libRoot, "podman", "readiness.ts");
  const clockPath = join(libRoot, "scenario", "clock.ts");

  function collectTsFiles(directory: string): string[] {
    const entries = readdirSync(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectTsFiles(fullPath));
      } else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      ) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const violations: string[] = [];
  for (const filePath of collectTsFiles(libRoot)) {
    if (filePath === readinessPath || filePath === clockPath) {
      continue;
    }
    const text = readFileSync(filePath, "utf8");
    if (text.includes("setTimeout")) {
      violations.push(filePath);
    }
  }

  assert.deepEqual(violations, []);
});
