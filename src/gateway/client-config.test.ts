import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { temporary } from "../kernel/test-support.ts";
import { writePrivate } from "../kernel/files.ts";
import { clientConfigPath, resolveClient } from "./client.ts";

const DEFAULT_ENDPOINT = "http://127.0.0.1:31415";
const TokenFixture = {
  File: "new-token",
  Environment: "environment",
  Option: "option",
} as const;
const EndpointFixture = {
  File: "http://localhost:12345",
  Environment: "http://localhost:23456",
  Option: "http://localhost:34567",
} as const;

test("operator-supplied client config preserves precedence and permissions without login", (t) => {
  const directory = temporary(t);
  const env = { XDG_CONFIG_HOME: directory };
  assert.equal(resolveClient({}, env).endpoint, DEFAULT_ENDPOINT);
  assert.throws(() => resolveClient({ endpoint: "invalid" }, env), {
    code: "cli.config.invalid_endpoint",
  });
  writePrivate(
    clientConfigPath(env),
    stringify({ endpoint: "http://localhost:12345", token: "new-token" }),
  );
  assert.deepEqual(readdirSync(join(directory, "kanthord")), ["cli.yaml"]);
  assert.equal(resolveClient({}, env).token, TokenFixture.File);
  assert.equal(
    resolveClient({}, { ...env, KANTHORD_TOKEN: "environment" }).token,
    TokenFixture.Environment,
  );
  assert.equal(
    resolveClient(
      { token: "option" },
      { ...env, KANTHORD_TOKEN: "environment" },
    ).token,
    TokenFixture.Option,
  );
  assert.equal(resolveClient({}, env).endpoint, EndpointFixture.File);
  assert.equal(
    resolveClient(
      {},
      { ...env, KANTHORD_ENDPOINT: EndpointFixture.Environment },
    ).endpoint,
    EndpointFixture.Environment,
  );
  assert.equal(
    resolveClient(
      { endpoint: EndpointFixture.Option },
      { ...env, KANTHORD_ENDPOINT: EndpointFixture.Environment },
    ).endpoint,
    EndpointFixture.Option,
  );
  chmodSync(clientConfigPath(env), 0o644);
  assert.throws(() => resolveClient({}, env), /mode 600/);
  chmodSync(clientConfigPath(env), 0o600);
  assert.equal(resolveClient({}, env).token, TokenFixture.File);
});
