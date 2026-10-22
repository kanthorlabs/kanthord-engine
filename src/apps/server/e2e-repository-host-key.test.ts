import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { errorSchema } from "../../kernel/errors.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  HostKeyErrorCode,
  HostKeySource,
  hostKeyItemSchema,
  hostKeyListAnswerSchema,
  hostKeyScanAnswerSchema,
} from "../../repository/contract.ts";
import { environment, kanthord } from "./cli-support.ts";
import { gatewayFixture } from "./test-support.ts";
import { createIdempotencyKey } from "../../kernel/identity.ts";

const GITHUB = "github.com";
const GITLAB = "gitlab.com";
const GITHUB_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const GITHUB_FINGERPRINT = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU";
const GITLAB_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf";
const GITLAB_FINGERPRINT = "SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8";
const HOST_KEY_PATH = "/api/repository/host-key";
const SCAN_FAILED_STATUS = 422;
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EMPTY_OUTPUT = "";
const HOST_KEY = ["repository", "host-key"];
const META_READS_OF_SCAN_AND_PIN = 2;
const KEYSCAN_READS_OF_ONE_PIN = 1;

async function setup(t: TestContext) {
  const reads = { meta: 0, keyscan: 0 };
  const keys = new Map([[GITLAB, GITLAB_KEY]]);
  const fixture = await gatewayFixture(t, {
    hostKeySources: {
      githubMeta: async () => {
        reads.meta += 1;
        return { ssh_keys: [GITHUB_KEY] };
      },
      keyscan: async (host) => {
        reads.keyscan += 1;
        return `# ${host}:22 SSH-2.0-OpenSSH_9.6\n${host} ${keys.get(host) ?? ""}\n`;
      },
    },
  });
  const headers = (key?: string) => ({
    authorization: `Bearer ${fixture.token}`,
    "content-type": "application/json",
    ...(key === undefined ? {} : { "idempotency-key": key }),
  });
  const directory = temporary(t);
  const env = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  return { fixture, reads, keys, headers, env };
}

test("scan, pin and list a host key through HTTP", async (t) => {
  const { fixture, reads, headers } = await setup(t);
  const scanned = await fixture.request(`${HOST_KEY_PATH}/scan`, {
    method: HttpMethod.Post,
    headers: headers(),
    body: JSON.stringify({ host: GITHUB }),
  });
  assert.equal(scanned.status, HttpStatus.OK);
  assert.deepEqual(hostKeyScanAnswerSchema.parse(await scanned.json()), {
    host: GITHUB,
    public_key: GITHUB_KEY,
    fingerprint: GITHUB_FINGERPRINT,
    source: HostKeySource.GitHubMeta,
  });
  const pinned = await fixture.request(`${HOST_KEY_PATH}/${GITHUB}`, {
    method: HttpMethod.Put,
    headers: headers(createIdempotencyKey()),
    body: JSON.stringify({ fingerprint: GITHUB_FINGERPRINT }),
  });
  assert.equal(pinned.status, HttpStatus.OK);
  const item = hostKeyItemSchema.parse(await pinned.json());
  assert.equal(item.fingerprint, GITHUB_FINGERPRINT);
  assert.equal(reads.meta, META_READS_OF_SCAN_AND_PIN);
  const listed = await fixture.request(HOST_KEY_PATH, { headers: headers() });
  assert.equal(listed.status, HttpStatus.OK);
  assert.deepEqual(hostKeyListAnswerSchema.parse(await listed.json()), {
    items: [item],
    next_cursor: null,
  });
});

test("a repeated Idempotency-Key answers the same pinned item without a read", async (t) => {
  const { fixture, reads, keys, headers } = await setup(t);
  const key = createIdempotencyKey();
  const pin = () =>
    fixture.request(`${HOST_KEY_PATH}/${GITLAB}`, {
      method: HttpMethod.Put,
      headers: headers(key),
      body: JSON.stringify({ fingerprint: GITLAB_FINGERPRINT }),
    });
  const first = await pin();
  assert.equal(first.status, HttpStatus.OK);
  const item = hostKeyItemSchema.parse(await first.json());
  keys.set(GITLAB, GITHUB_KEY);
  const second = await pin();
  assert.equal(second.status, HttpStatus.OK);
  assert.deepEqual(hostKeyItemSchema.parse(await second.json()), item);
  assert.equal(reads.keyscan, KEYSCAN_READS_OF_ONE_PIN);
});

test("a pin without Idempotency-Key, an unsupported host and a failed scan refuse", async (t) => {
  const { fixture, keys, headers } = await setup(t);
  const unkeyed = await fixture.request(`${HOST_KEY_PATH}/${GITHUB}`, {
    method: HttpMethod.Put,
    headers: headers(),
    body: JSON.stringify({ fingerprint: GITHUB_FINGERPRINT }),
  });
  assert.equal(unkeyed.status, HttpStatus.BadRequest);
  const unsupported = await fixture.request(`${HOST_KEY_PATH}/scan`, {
    method: HttpMethod.Post,
    headers: headers(),
    body: JSON.stringify({ host: "example.com" }),
  });
  assert.equal(unsupported.status, HttpStatus.BadRequest);
  assert.equal(
    errorSchema.parse(await unsupported.json()).error.code,
    HostKeyErrorCode.HostUnsupported,
  );
  keys.delete(GITLAB);
  const failed = await fixture.request(`${HOST_KEY_PATH}/scan`, {
    method: HttpMethod.Post,
    headers: headers(),
    body: JSON.stringify({ host: GITLAB }),
  });
  assert.equal(failed.status, SCAN_FAILED_STATUS);
  const body = errorSchema.parse(await failed.json());
  assert.equal(body.error.code, HostKeyErrorCode.ScanFailed);
  assert.deepEqual(body.error.details, { host: GITLAB });
});

test("the CLI scans, pins and lists a host key", async (t) => {
  const { env } = await setup(t);
  const scan = await kanthord([...HOST_KEY, "scan", GITLAB], env);
  assert.equal(scan.code, EXIT_SUCCESS, scan.stderr);
  assert.equal(scan.stderr, EMPTY_OUTPUT);
  assert.deepEqual(JSON.parse(scan.stdout), {
    host: GITLAB,
    public_key: GITLAB_KEY,
    fingerprint: GITLAB_FINGERPRINT,
    source: HostKeySource.Keyscan,
  });
  const key = createIdempotencyKey();
  const pin = await kanthord(
    [
      ...HOST_KEY,
      "pin",
      GITLAB,
      "--fingerprint",
      GITLAB_FINGERPRINT,
      "--idempotency-key",
      key,
    ],
    env,
  );
  assert.equal(pin.code, EXIT_SUCCESS, pin.stderr);
  const pinned = JSON.parse(pin.stdout);
  assert.equal(pinned.idempotency_key, key);
  assert.equal(pinned.fingerprint, GITLAB_FINGERPRINT);
  const list = await kanthord([...HOST_KEY, "list"], env);
  assert.equal(list.code, EXIT_SUCCESS, list.stderr);
  const item = { ...pinned };
  delete item.idempotency_key;
  assert.deepEqual(JSON.parse(list.stdout), {
    items: [item],
    next_cursor: null,
  });
});

test("the CLI refuses an invalid fingerprint before a request and names a server refusal", async (t) => {
  const { env } = await setup(t);
  const invalid = await kanthord(
    [...HOST_KEY, "pin", GITLAB, "--fingerprint", "MD5:00"],
    env,
  );
  assert.equal(invalid.code, EXIT_FAILURE);
  assert.equal(invalid.stdout, EMPTY_OUTPUT);
  assert.ok(
    invalid.stderr.startsWith(
      "cli.repository.host_key.pin.fingerprint_invalid:",
    ),
    invalid.stderr,
  );
  const changed = await kanthord(
    [...HOST_KEY, "pin", GITLAB, "--fingerprint", GITHUB_FINGERPRINT],
    env,
  );
  assert.equal(changed.code, EXIT_FAILURE);
  assert.ok(
    changed.stderr.startsWith("repository.host_key.changed:"),
    changed.stderr,
  );
  const unsupported = await kanthord([...HOST_KEY, "scan", "example.com"], env);
  assert.equal(unsupported.code, EXIT_FAILURE);
  assert.ok(
    unsupported.stderr.startsWith("repository.host_key.host_unsupported:"),
    unsupported.stderr,
  );
});

test("the CLI refuses each host-key command without a token", async (t) => {
  const { env } = await setup(t);
  const unauthenticated = { ...env, KANTHORD_TOKEN: undefined };
  for (const [args, command] of [
    [["list"], "list"],
    [["scan", GITLAB], "scan"],
    [["pin", GITLAB, "--fingerprint", GITLAB_FINGERPRINT], "pin"],
  ] as const) {
    const result = await kanthord([...HOST_KEY, ...args], unauthenticated);
    assert.equal(result.code, EXIT_FAILURE);
    assert.ok(
      result.stderr.startsWith(
        `cli.repository.host_key.${command}.token_required:`,
      ),
      result.stderr,
    );
  }
});
