import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { connect } from "node:net";

import { transportCases, runTransportCases } from "./transport.ts";
import { transportAssertionNames } from "./assertions.ts";
import type { HttpIssuer } from "../driver/index.ts";
import type { ScenarioContext } from "./context.ts";
import { RunnerError } from "../errors.ts";
import { redact, secrets } from "../redact.ts";

const token = "s3cr3t-tok";
const allowedHost = "127.0.0.1:9999";

const expectedNames = [
  "no-token",
  "wrong-token",
  "origin-header",
  "foreign-host",
  "absent-host",
  "allowed-host",
] as const;

const declaredKeys = [
  "name",
  "token",
  "host",
  "origin",
  "expectedStatus",
  "expectedCode",
];

function buildContext(): Readonly<{
  context: ScenarioContext;
  assertions: { name: string; passed: boolean }[];
  logs: Record<string, string>;
}> {
  const assertions: { name: string; passed: boolean }[] = [];
  const logs: Record<string, string> = {};
  const context: ScenarioContext = {
    tag: "transport-test",
    scenarioId: "P1-E2",
    bundleDirectory: "/dev/null",
    take(): void {},
    sink: {
      print(): void {},
      record(): void {},
    },
    assert(name: string, expected: unknown, actual: unknown): void {
      let passed = true;
      try {
        assert.deepStrictEqual(actual, expected);
      } catch {
        passed = false;
      }
      assertions.push({ name, passed });
      if (!passed) {
        throw new RunnerError("assertion-failed", name);
      }
    },
    attachLog(name: string, text: string): void {
      logs[name] = text;
    },
    daemonHost: null,
    clientHost: null,
  };
  return { context, assertions, logs };
}

async function startEchoServer(): Promise<
  Readonly<{
    server: Server;
    port: number;
    received: IncomingHttpHeaders[];
    close(): Promise<void>;
  }>
> {
  const received: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    received.push(req.headers);
    const origin = req.headers.origin;
    const host = req.headers.host;
    const auth = req.headers.authorization;
    let status: number;
    let code: string | null;
    if (origin !== undefined) {
      status = 403;
      code = "origin-forbidden";
    } else if (
      host === undefined ||
      host.toLowerCase() !== allowedHost.toLowerCase()
    ) {
      status = 403;
      code = "host-forbidden";
    } else if (auth === undefined || auth !== `Bearer ${token}`) {
      status = 401;
      code = "unauthenticated";
    } else {
      status = 200;
      code = null;
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      code === null ? "{}" : JSON.stringify({ error: { code, message: code } }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return {
    server,
    port,
    received,
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function issueWithNoHostHeader(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<Readonly<{ status: number; body: string }>> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      const headerLines = Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}\r\n`)
        .join("");
      socket.write(`${method} ${path} HTTP/1.0\r\n${headerLines}\r\n`);
    });
    let raw = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      raw = Buffer.concat([raw, chunk]);
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const text = raw.toString("utf8");
      const separator = text.indexOf("\r\n\r\n");
      const head = separator === -1 ? text : text.slice(0, separator);
      const body = separator === -1 ? "" : text.slice(separator + 4);
      const statusLine = head.split("\r\n")[0] ?? "";
      const status = Number(statusLine.split(" ")[1] ?? "0");
      resolve({ status, body });
    });
  });
}

function makeIssuer(port: number): HttpIssuer {
  return async (input) => {
    if (input.omitHost) {
      return issueWithNoHostHeader(
        port,
        input.method,
        input.path,
        input.headers,
      );
    }
    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          method: input.method,
          hostname: "127.0.0.1",
          port,
          path: input.path,
          headers: input.headers,
          setHost: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
  };
}

test("transportCases has exactly six rows, the exact names, in the exact order, no selection flag", () => {
  assert.equal(transportCases.length, 6);
  assert.deepEqual(
    transportCases.map((row) => row.name),
    [...expectedNames],
  );
  for (const row of transportCases) {
    assert.deepEqual(Object.keys(row), declaredKeys);
  }
});

test("transportCases carries the exact table values", () => {
  assert.deepEqual(transportCases, [
    {
      name: "no-token",
      token: "absent",
      host: "allowed",
      origin: null,
      expectedStatus: 401,
      expectedCode: "unauthenticated",
    },
    {
      name: "wrong-token",
      token: "wrong",
      host: "allowed",
      origin: null,
      expectedStatus: 401,
      expectedCode: "unauthenticated",
    },
    {
      name: "origin-header",
      token: "valid",
      host: "allowed",
      origin: "http://evil.example",
      expectedStatus: 403,
      expectedCode: "origin-forbidden",
    },
    {
      name: "foreign-host",
      token: "valid",
      host: "foreign",
      origin: null,
      expectedStatus: 403,
      expectedCode: "host-forbidden",
    },
    {
      name: "absent-host",
      token: "valid",
      host: "absent",
      origin: null,
      expectedStatus: 403,
      expectedCode: "host-forbidden",
    },
    {
      name: "allowed-host",
      token: "valid",
      host: "allowed",
      origin: null,
      expectedStatus: 200,
      expectedCode: null,
    },
  ]);
});

test("runTransportCases records exactly eleven assertions, in table order, over a live echo server", async () => {
  const echo = await startEchoServer();
  try {
    const { context, assertions, logs } = buildContext();
    await runTransportCases(
      context,
      { allowedHost, token },
      makeIssuer(echo.port),
    );

    assert.deepEqual(
      assertions.map((entry) => entry.name),
      [
        "no-token-status",
        "no-token-code",
        "wrong-token-status",
        "wrong-token-code",
        "origin-header-status",
        "origin-header-code",
        "foreign-host-status",
        "foreign-host-code",
        "absent-host-status",
        "absent-host-code",
        "allowed-host-status",
      ],
    );
    assert.ok(assertions.every((entry) => entry.passed));

    assert.equal(echo.received.length, 6);
    assert.equal(echo.received[0]?.authorization, undefined);
    assert.equal(echo.received[1]?.authorization, `Bearer ${token}x`);
    for (const index of [0, 1, 3, 4, 5]) {
      assert.equal(Object.hasOwn(echo.received[index] ?? {}, "origin"), false);
    }
    assert.equal(echo.received[2]?.origin, "http://evil.example");
    assert.equal(Object.hasOwn(echo.received[4] ?? {}, "host"), false);

    // The attached log is RAW on purpose: assertNoDisclosure reads it to prove the
    // secret was never emitted, which an already-redacted log cannot establish. The
    // Authorization value is therefore never formatted into the log in the first
    // place — the log describes the case, so absence is true by construction rather
    // than true because the redactor ran.
    const wrongTokenLog = logs["wrong-token.http"] ?? "";
    assert.equal(
      wrongTokenLog.includes("Authorization: Bearer <wrong-token>"),
      true,
    );
    assert.equal(
      logs["allowed-host.http"]?.includes(
        "Authorization: Bearer <valid-token>",
      ),
      true,
    );
    for (const text of Object.values(logs)) {
      assert.equal(text.includes(token), false);
      assert.equal(text.includes(redact(token)), false);
    }
  } finally {
    await echo.close();
  }
});

test("runTransportCases sends no Origin header at all for a row whose origin is null", async () => {
  const echo = await startEchoServer();
  try {
    const { context } = buildContext();
    await runTransportCases(
      context,
      { allowedHost, token },
      makeIssuer(echo.port),
    );
    const rowsWithNullOrigin = [0, 1, 3, 4, 5];
    for (const index of rowsWithNullOrigin) {
      assert.equal(Object.hasOwn(echo.received[index] ?? {}, "origin"), false);
    }
  } finally {
    await echo.close();
  }
});

test("SECURITY: runTransportCases holds the bearer token in the shared secret registry, so its base64 and user:token@ forms are redacted wherever else the bundle logs it", async () => {
  const echo = await startEchoServer();
  try {
    const { context } = buildContext();
    await runTransportCases(
      context,
      { allowedHost, token },
      makeIssuer(echo.port),
    );

    assert.equal(secrets.values().includes(token), true);
  } finally {
    await echo.close();
  }
});

test("a server answering 200 where the case expects 401 makes runTransportCases reject naming no-token-status", async () => {
  const { context } = buildContext();
  const alwaysOk: HttpIssuer = async () => ({ status: 200, body: "{}" });
  await assert.rejects(
    runTransportCases(context, { allowedHost, token }, alwaysOk),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.code === "assertion-failed" &&
      error.message === "no-token-status",
  );
});

test("transportAssertionNames equals the names runTransportCases actually records, in order", async () => {
  const echo = await startEchoServer();
  try {
    const { context, assertions } = buildContext();

    await runTransportCases(
      context,
      { allowedHost, token },
      makeIssuer(echo.port),
    );

    assert.deepEqual(
      assertions.map((entry) => entry.name),
      [...transportAssertionNames],
    );
  } finally {
    await echo.close();
  }
});
