import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { podmanIssuer } from "./podman-issuer.ts";
import { createLocalIssuer } from "./local.ts";
import type { CommandRecord } from "../command.ts";
import type { PodmanExecutor } from "./podman.ts";

function record(argv: readonly string[], stdout: string): CommandRecord {
  return { argv, cwd: process.cwd(), exitCode: 0, stdout, stderr: "" };
}

test("podmanIssuer issues exactly one podman exec --interactive call, writes the request as JSON on stdin, and no secret shape leaks into argv", async () => {
  const calls: (readonly string[])[] = [];
  const stdins: (string | undefined)[] = [];
  const execute: PodmanExecutor = async (argv, stdin) => {
    calls.push(argv);
    stdins.push(stdin);
    return record(argv, "200\n{}");
  };

  const issue = podmanIssuer(
    execute,
    "kanthord-e2e-client-R1",
    "http://kanthord-daemon:7421",
  );
  const response = await issue({
    method: "GET",
    path: "/v1/status",
    headers: { Authorization: "Bearer sekrit-token-value" },
    omitHost: false,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    "podman",
    "exec",
    "--interactive",
    "kanthord-e2e-client-R1",
    "node",
    "/opt/e2e/bin/e2e-request.mjs",
  ]);
  assert.equal(response.status, 200);
  assert.equal(response.body, "{}");

  const argvText = (calls[0] as readonly string[]).join(" ");
  assert.equal(argvText.includes("{"), false);
  assert.equal(argvText.toLowerCase().includes("authorization"), false);
  assert.equal(argvText.includes("sekrit-token-value"), false);

  const payload = JSON.parse(stdins[0] as string) as Readonly<{
    method: string;
    path: string;
    headers: Readonly<Record<string, string>>;
  }>;
  assert.equal(payload.method, "GET");
  assert.equal(payload.path, "/v1/status");
  assert.equal(payload.headers.Authorization, "Bearer sekrit-token-value");
});

test("podmanIssuer parses <status>\\n<body> off stdout, and a multi-line JSON body round-trips", async () => {
  const body = JSON.stringify({ error: { code: "host-forbidden" } });
  const execute: PodmanExecutor = async (argv) => record(argv, `403\n${body}`);
  const issue = podmanIssuer(
    execute,
    "kanthord-e2e-client-R1",
    "http://kanthord-daemon:7421",
  );

  const response = await issue({
    method: "GET",
    path: "/v1/status",
    headers: {},
    omitHost: true,
  });

  assert.equal(response.status, 403);
  assert.equal(response.body, body);
});

test("localIssuer and podmanIssuer forward the same header set for the same request", async () => {
  let capturedLocal:
    | Readonly<{ authorization: string | undefined; host: string | undefined }>
    | undefined;
  const server = createServer((req, res) => {
    capturedLocal = {
      authorization: req.headers.authorization,
      host: req.headers.host,
    };
    res.statusCode = 200;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;

  const localIssue = createLocalIssuer(
    () => `http://127.0.0.1:${String(port)}`,
  );
  await localIssue({
    method: "GET",
    path: "/v1/status",
    headers: { Authorization: "Bearer tkn", Host: "kanthord-daemon:7421" },
    omitHost: false,
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));

  let capturedPodman:
    | Readonly<{ authorization: string | undefined; host: string | undefined }>
    | undefined;
  const execute: PodmanExecutor = async (argv, stdin) => {
    const payload = JSON.parse(stdin as string) as Readonly<{
      headers: Readonly<Record<string, string>>;
    }>;
    capturedPodman = {
      authorization: payload.headers.Authorization,
      host: payload.headers.Host,
    };
    return record(argv, "200\n{}");
  };
  const podmanIssue = podmanIssuer(
    execute,
    "kanthord-e2e-client-R1",
    "http://kanthord-daemon:7421",
  );
  await podmanIssue({
    method: "GET",
    path: "/v1/status",
    headers: { Authorization: "Bearer tkn", Host: "kanthord-daemon:7421" },
    omitHost: false,
  });

  assert.equal(capturedLocal?.authorization, "Bearer tkn");
  assert.equal(capturedPodman?.authorization, "Bearer tkn");
  assert.equal(capturedLocal?.host, "kanthord-daemon:7421");
  assert.equal(capturedPodman?.host, "kanthord-daemon:7421");
});
