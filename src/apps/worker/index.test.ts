import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { readdirSync } from "node:fs";
import { stringify } from "yaml";
import { CancellationContext } from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { packageVersion } from "../../kernel/version.ts";
import { temporary } from "../../kernel/test-support.ts";
import { isString } from "../../kernel/values.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { Worker, runWorker } from "./index.ts";

const STARTED_MESSAGE = "Worker application started";
const MISMATCH_VERSION = "0.0.0-mismatch";
const MISMATCH_CODE = "worker.version.mismatch";
const UNAVAILABLE_CODE = "worker.version.unavailable";
const OPENAPI_PATH = "/api/openapi.yaml";
const AUTHORIZATION = "Bearer test-token";

async function fixture(t: TestContext, version: string) {
  let requests = 0;
  const listener = createServer((request, response) => {
    assert.equal(request.url, OPENAPI_PATH);
    assert.equal(request.headers.authorization, AUTHORIZATION);
    requests++;
    response.writeHead(HttpStatus.OK, { "Content-Type": "application/yaml" });
    response.end(stringify({ info: { version } }));
  });
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = listener.address();
  assert.ok(address && !isString(address));
  const directory = temporary(t);
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    token: "test-token",
    env: { XDG_CONFIG_HOME: directory },
    directory,
    requests: () => requests,
  };
}

test("matching worker starts once and joins context cancellation without server configuration or database", async (t) => {
  const options = await fixture(t, packageVersion());
  const messages: string[] = [];
  const worker = new Worker({
    ...options,
    log: (message) => {
      messages.push(message);
    },
  });
  const context = new CancellationContext();
  const signals = process.listenerCount("SIGTERM");
  const running = worker.run(context);
  assert.equal(worker.start(), worker.start());
  assert.equal(await worker.start(), null);
  assert.deepEqual(await worker.healthcheck(), { client: HttpStatus.OK });
  assert.deepEqual(messages, [STARTED_MESSAGE]);
  const SINGLE_REQUEST = 1;
  assert.equal(options.requests(), SINGLE_REQUEST);
  context.cancel();
  assert.equal(await running, context.err());
  assert.equal(worker.quiesce(), worker.quiesce());
  assert.equal(worker.stop(), worker.stop());
  assert.equal(await worker.stop(), null);
  assert.deepEqual(await worker.healthcheck(), {
    client: HttpStatus.ServiceUnavailable,
  });
  assert.equal(process.listenerCount("SIGTERM"), signals);
  assert.deepEqual(readdirSync(options.directory), []);
  assert.ok((await worker.start()) instanceof Error);
});

test("version mismatch names both versions, starts nothing and releases signal listeners", async (t) => {
  const options = await fixture(t, MISMATCH_VERSION);
  const messages: string[] = [];
  const signals = process.listenerCount("SIGTERM");
  const error = await runWorker({
    ...options,
    log: (message) => {
      messages.push(message);
    },
  });
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, MISMATCH_CODE);
  assert.ok(error.message.includes(packageVersion()));
  assert.ok(error.message.includes(MISMATCH_VERSION));
  assert.deepEqual(messages, []);
  assert.deepEqual(readdirSync(options.directory), []);
  assert.equal(process.listenerCount("SIGTERM"), signals);
});

test("worker signal stops cleanly and unavailable server yields a distinct diagnostic", async (t) => {
  const options = await fixture(t, packageVersion());
  const started = Promise.withResolvers<void>();
  const running = runWorker({ ...options, log: () => started.resolve() });
  await started.promise;
  process.emit("SIGTERM");
  assert.equal(await running, null);
  const error = await runWorker({ ...options, endpoint: "http://127.0.0.1:1" });
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, UNAVAILABLE_CODE);
});
