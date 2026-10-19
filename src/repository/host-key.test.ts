import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  HOST_KEY_SCAN_FAILED_STATUS,
  HostKeyErrorCode,
  HostKeySource,
  repositoryOperations,
} from "./contract.ts";
import {
  keyscanArguments,
  parseGitHubMeta,
  parseKeyscan,
  RepositoryHostKeys,
  type HostKeySources,
} from "./host-key.ts";
import { repositoryMigrations } from "./migrations.ts";
import {
  isGitHubSshHost,
  isSshHost,
  sshKnownHostsName,
  sshPortOf,
} from "./platform.ts";
import { sshFingerprintOf } from "./ssh-key.ts";

const REPOSITORY_SERVICE = "repository";
const GITHUB_KEY_BODY =
  "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const GITHUB_KEY = `ssh-ed25519 ${GITHUB_KEY_BODY}`;
const GITHUB_FINGERPRINT = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU";
const GITHUB_META = {
  ssh_keys: [
    GITHUB_KEY,
    "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
    "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=",
  ],
};
const GITLAB = "gitlab.com";
const GITHUB = "github.com";
const SSH_GITHUB = "ssh.github.com";
const ALTSSH_GITLAB = "altssh.gitlab.com";
const ALTSSH_BITBUCKET = "altssh.bitbucket.org";
const KEYSCAN_PREFIX = `# ${GITLAB}:22 SSH-2.0-OpenSSH_9.6\n`;
const LAST_PAGE_ITEMS = 1;
const GENERATED_KEYS = 3;
const EXIT_SUCCESS = 0;
const NO_READS = 0;
const READ_PER_PIN = 1;
const META_READ_PER_HOST = 2;
const ONE_ROW_PER_HOST = 1;
const NO_PINS = 0;
const PIN_LOG = "host key pinned";
const NON_BASE64_SUFFIX = "!";
const GITHUB_MIXED_CASE = "GitHub.COM";
const GITLAB_MIXED_CASE = "GitLab.COM";

function ed25519Key(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(
    publicKey.export({ format: "jwk" }).x as string,
    "base64url",
  );
  const type = Buffer.from("ssh-ed25519");
  const blob = Buffer.alloc(4 + type.length + 4 + raw.length);
  blob.writeUInt32BE(type.length, 0);
  type.copy(blob, 4);
  blob.writeUInt32BE(raw.length, 4 + type.length);
  raw.copy(blob, 8 + type.length);
  return `ssh-ed25519 ${blob.toString("base64")}`;
}

function keyscanOutput(host: string, key: string): string {
  return `# ${host}:${sshPortOf(host)} SSH-2.0-OpenSSH_9.6\n${sshKnownHostsName(host)} ${key}\n`;
}

function fails(error: unknown, status: number, code: string): boolean {
  return (
    error instanceof OperationError &&
    error.status === status &&
    error.code === code
  );
}

function fixture(t: TestContext, sources: Partial<HostKeySources> = {}) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: REPOSITORY_SERVICE, migrations: repositoryMigrations },
  ]);
  const reads = { meta: 0, keyscan: [] as string[] };
  const keys = new Map<string, string>([[GITLAB, ed25519Key()]]);
  const meta = { body: GITHUB_META as unknown };
  const logs: string[] = [];
  const hostKeys = new RepositoryHostKeys({
    logger: pino({ level: "info" }, { write: (line) => logs.push(line) }),
    sources: {
      githubMeta: async () => {
        reads.meta += 1;
        return meta.body;
      },
      keyscan: async (host: string) => {
        reads.keyscan.push(host);
        if (!keys.has(host)) keys.set(host, ed25519Key());
        return keyscanOutput(host, keys.get(host)!);
      },
      ...sources,
    },
  });
  const registry = new OperationRegistry();
  hostKeys.declare(registry);
  const caller: CallerContext = {
    identity: { kind: "human", accountId: "alice", name: "Alice", jti: "j" },
    context: background,
    requestId: "request",
    commit: (write) => store.transaction(write),
  };
  const invoke = async (
    operation: (typeof repositoryOperations)[keyof typeof repositoryOperations],
    input: unknown,
  ) => registry.get(operation.id).handler(operation.input.parse(input), caller);
  const scan = (host: string) =>
    invoke(repositoryOperations.host_key_scan, {
      params: {},
      query: {},
      body: { host },
    }) as Promise<{ host: string; public_key: string; fingerprint: string }>;
  const pin = (host: string, fingerprint: string) =>
    invoke(repositoryOperations.host_key_pin, {
      params: { host },
      query: {},
      body: { fingerprint },
    });
  const list = (query: Record<string, string> = {}) =>
    invoke(repositoryOperations.host_key_list, {
      params: {},
      query,
      body: null,
    }) as Promise<{
      items: { host: string; source: string; fingerprint: string }[];
      next_cursor: string | null;
    }>;
  return { store, hostKeys, reads, keys, meta, logs, scan, pin, list };
}

test("the SSH host predicates accept each host of the SSH host sets", () => {
  for (const host of [
    "github.com",
    "ssh.github.com",
    "gitlab.com",
    "altssh.gitlab.com",
    "bitbucket.org",
    "altssh.bitbucket.org",
  ])
    assert.ok(isSshHost(host), host);
  assert.ok(!isSshHost("example.com"));
  assert.ok(!isSshHost("github"));
  assert.ok(isGitHubSshHost("github.com"));
  assert.ok(isGitHubSshHost("ssh.github.com"));
  assert.ok(!isGitHubSshHost("gitlab.com"));
});

test("the meta parse takes the ed25519 entry of ssh_keys", () => {
  assert.equal(parseGitHubMeta(GITHUB_META), GITHUB_KEY);
  assert.equal(parseGitHubMeta({ ssh_keys: [GITHUB_META.ssh_keys[1]] }), null);
  assert.equal(parseGitHubMeta({ ssh_keys: "x" }), null);
  assert.equal(parseGitHubMeta(null), null);
  assert.equal(parseGitHubMeta({ ssh_keys: ["ssh-ed25519 AAAA"] }), null);
  assert.equal(
    parseGitHubMeta({ ssh_keys: [`${GITHUB_KEY}${NON_BASE64_SUFFIX}`] }),
    null,
  );
});

test("the keyscan parse skips the comment line and takes the ed25519 line of the host", () => {
  const key = ed25519Key();
  assert.equal(
    parseKeyscan(GITLAB, `${KEYSCAN_PREFIX}${GITLAB} ${key}\n`),
    key,
  );
  assert.equal(parseKeyscan(GITLAB, KEYSCAN_PREFIX), null);
  assert.equal(parseKeyscan(GITLAB, `other.com ${key}\n`), null);
  assert.equal(parseKeyscan(GITLAB, `${GITLAB} ssh-rsa AAAAB3Nza\n`), null);
  assert.equal(
    parseKeyscan(GITLAB, `${GITLAB} ${key}${NON_BASE64_SUFFIX}\n`),
    null,
  );
});

test("the keyscan parse of an alternative SSH host takes the line of the bracket form", () => {
  const key = ed25519Key();
  assert.equal(
    parseKeyscan(
      ALTSSH_GITLAB,
      `# ${ALTSSH_GITLAB}:443 SSH-2.0-GitLab-SSHD\n[${ALTSSH_GITLAB}]:443 ${key}\n`,
    ),
    key,
  );
  assert.equal(parseKeyscan(ALTSSH_GITLAB, `${ALTSSH_GITLAB} ${key}\n`), null);
});

test("the keyscan arguments carry the port of the host", () => {
  const argumentsOf = (port: string, host: string) => [
    "-T",
    "5",
    "-t",
    "ed25519",
    "-p",
    port,
    "--",
    host,
  ];
  assert.deepEqual(keyscanArguments(GITLAB), argumentsOf("22", GITLAB));
  assert.deepEqual(
    keyscanArguments(ALTSSH_GITLAB),
    argumentsOf("443", ALTSSH_GITLAB),
  );
  assert.deepEqual(
    keyscanArguments(ALTSSH_BITBUCKET),
    argumentsOf("443", ALTSSH_BITBUCKET),
  );
  assert.deepEqual(
    keyscanArguments(SSH_GITHUB),
    argumentsOf("443", SSH_GITHUB),
  );
});

test("the fingerprint equals the output of ssh-keygen -l", () => {
  assert.equal(sshFingerprintOf(GITHUB_KEY), GITHUB_FINGERPRINT);
  for (let index = 0; index < GENERATED_KEYS; index++) {
    const key = ed25519Key();
    const result = spawnSync("ssh-keygen", ["-l", "-f", "-"], {
      input: `${key}\n`,
      encoding: "utf8",
    });
    assert.equal(result.status, EXIT_SUCCESS, result.stderr);
    assert.equal(result.stdout.split(" ")[1], sshFingerprintOf(key));
  }
});

test("a scan of a GitHub host reads the meta and derives the source", async (t) => {
  const f = fixture(t);
  for (const host of ["github.com", "ssh.github.com"])
    assert.deepEqual(await f.scan(host), {
      host,
      public_key: GITHUB_KEY,
      fingerprint: GITHUB_FINGERPRINT,
      source: HostKeySource.GitHubMeta,
    });
  assert.equal(f.reads.meta, META_READ_PER_HOST);
  assert.deepEqual(f.reads.keyscan, []);
});

test("a scan of another host runs the keyscan seam with source keyscan", async (t) => {
  const f = fixture(t);
  const answer = await f.scan(GITLAB);
  assert.deepEqual(answer, {
    host: GITLAB,
    public_key: f.keys.get(GITLAB),
    fingerprint: sshFingerprintOf(f.keys.get(GITLAB)!),
    source: HostKeySource.Keyscan,
  });
  assert.deepEqual(f.reads.keyscan, [GITLAB]);
  assert.equal(f.reads.meta, NO_READS);
});

test("a meta answer with no ed25519 entry answers scan_failed", async (t) => {
  const f = fixture(t);
  f.meta.body = { ssh_keys: [GITHUB_META.ssh_keys[1]] };
  await assert.rejects(f.scan(GITHUB), (error) =>
    fails(error, HOST_KEY_SCAN_FAILED_STATUS, HostKeyErrorCode.ScanFailed),
  );
});

test("a failed source read answers scan_failed with the host", async (t) => {
  const f = fixture(t, {
    keyscan: async () => {
      throw new Error("timeout");
    },
  });
  await assert.rejects(f.scan(GITLAB), (error) => {
    assert.ok(
      fails(error, HOST_KEY_SCAN_FAILED_STATUS, HostKeyErrorCode.ScanFailed),
    );
    assert.deepEqual((error as OperationError).details, { host: GITLAB });
    return true;
  });
});

test("a host outside every SSH host set answers host_unsupported", async (t) => {
  const f = fixture(t);
  for (const run of [
    () => f.scan("example.com"),
    () => f.pin("example.com", GITHUB_FINGERPRINT),
  ])
    await assert.rejects(run(), (error) =>
      fails(error, HttpStatus.BadRequest, HostKeyErrorCode.HostUnsupported),
    );
  assert.equal(f.reads.meta, NO_READS);
  assert.deepEqual(f.reads.keyscan, []);
});

test("a pin reads the source again and stores the confirmed key", async (t) => {
  const f = fixture(t);
  const item = await f.pin(GITHUB, GITHUB_FINGERPRINT);
  assert.deepEqual(
    { ...(item as Record<string, unknown>), created_at: 0 },
    {
      host: GITHUB,
      public_key: GITHUB_KEY,
      fingerprint: GITHUB_FINGERPRINT,
      source: HostKeySource.GitHubMeta,
      created_at: 0,
    },
  );
  assert.equal(f.reads.meta, READ_PER_PIN);
  assert.equal(
    f.store.transaction((tx) => f.hostKeys.knownHostsLine(tx, GITHUB)),
    `${GITHUB} ${GITHUB_KEY}`,
  );
  const log = f.logs
    .map((line) => JSON.parse(line))
    .find((line) => line.msg === PIN_LOG);
  assert.deepEqual(
    {
      human_identity: log.human_identity,
      host: log.host,
      fingerprint: log.fingerprint,
      source: log.source,
    },
    {
      human_identity: "alice",
      host: GITHUB,
      fingerprint: GITHUB_FINGERPRINT,
      source: HostKeySource.GitHubMeta,
    },
  );
});

test("a pin whose second read answers another fingerprint answers changed", async (t) => {
  const f = fixture(t);
  const confirmed = (await f.scan(GITLAB)).fingerprint;
  const rotated = ed25519Key();
  f.keys.set(GITLAB, rotated);
  await assert.rejects(f.pin(GITLAB, confirmed), (error) => {
    assert.ok(fails(error, HttpStatus.Conflict, HostKeyErrorCode.Changed));
    assert.deepEqual((error as OperationError).details, {
      host: GITLAB,
      fingerprint: sshFingerprintOf(rotated),
    });
    return true;
  });
  assert.equal((await f.list()).items.length, NO_PINS);
});

test("a pin replaces the row of its host and keeps one row", async (t) => {
  const f = fixture(t);
  await f.pin(GITLAB, (await f.scan(GITLAB)).fingerprint);
  const next = ed25519Key();
  f.keys.set(GITLAB, next);
  await f.pin(GITLAB, sshFingerprintOf(next));
  const rows = f.store.database
    .prepare("SELECT id, host, public_key FROM repository_host_key")
    .all();
  assert.equal(rows.length, ONE_ROW_PER_HOST);
  assert.equal(rows[0]!.host, GITLAB);
  assert.equal(rows[0]!.public_key, next);
  assert.match(String(rows[0]!.id), /^host_key_[0-9A-HJKMNP-TV-Z]{26}$/);
});

test("a host in another case scans, pins and reads under its lower-case name", async (t) => {
  const f = fixture(t);
  assert.equal((await f.scan(GITHUB_MIXED_CASE)).host, GITHUB);
  await f.pin(GITLAB_MIXED_CASE, (await f.scan(GITLAB)).fingerprint);
  await f.pin(GITLAB, (await f.scan(GITLAB)).fingerprint);
  const rows = f.store.database
    .prepare("SELECT host FROM repository_host_key")
    .all();
  assert.deepEqual(
    rows.map((row) => row.host),
    [GITLAB],
  );
  assert.ok(
    f.store
      .transaction((tx) => f.hostKeys.knownHostsLine(tx, GITLAB_MIXED_CASE))
      .startsWith(`${GITLAB} `),
  );
});

test("an alternative SSH host pins under its name and reads its known-hosts line in the bracket form", async (t) => {
  const f = fixture(t);
  for (const host of [ALTSSH_GITLAB, ALTSSH_BITBUCKET]) {
    const read = await f.scan(host);
    assert.equal(read.host, host);
    await f.pin(host, read.fingerprint);
    assert.equal(
      f.store.transaction((tx) => f.hostKeys.knownHostsLine(tx, host)),
      `[${host}]:443 ${f.keys.get(host)}`,
    );
  }
  await f.pin(GITLAB, (await f.scan(GITLAB)).fingerprint);
  assert.equal(
    f.store.transaction((tx) => f.hostKeys.knownHostsLine(tx, GITLAB)),
    `${GITLAB} ${f.keys.get(GITLAB)}`,
  );
  assert.deepEqual(
    (await f.list()).items.map((item) => item.host),
    [ALTSSH_BITBUCKET, ALTSSH_GITLAB, GITLAB],
  );
});

test("ssh.github.com pins the GitHub meta key and reads its known-hosts line in the bracket form of port 443", async (t) => {
  const f = fixture(t);
  await f.pin(SSH_GITHUB, GITHUB_FINGERPRINT);
  await f.pin(GITHUB, GITHUB_FINGERPRINT);
  assert.equal(f.reads.meta, META_READ_PER_HOST * READ_PER_PIN);
  assert.deepEqual(f.reads.keyscan, []);
  assert.equal(
    f.store.transaction((tx) => f.hostKeys.knownHostsLine(tx, SSH_GITHUB)),
    `[${SSH_GITHUB}]:443 ${GITHUB_KEY}`,
  );
  assert.equal(
    f.store.transaction((tx) => f.hostKeys.knownHostsLine(tx, GITHUB)),
    `${GITHUB} ${GITHUB_KEY}`,
  );
  assert.deepEqual(
    (await f.list()).items.map((item) => item.host),
    [GITHUB, SSH_GITHUB],
  );
});

test("an unpinned host refuses its known-hosts line with unpinned", (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.store.transaction((tx) => f.hostKeys.knownHostsLine(tx, GITLAB)),
    (error) => {
      assert.ok(fails(error, HttpStatus.Conflict, HostKeyErrorCode.Unpinned));
      assert.deepEqual((error as OperationError).details, { host: GITLAB });
      return true;
    },
  );
});

test("the list answers the pins by host ascending with a cursor and a derived source", async (t) => {
  const f = fixture(t);
  for (const host of ["ssh.github.com", "gitlab.com", "bitbucket.org"]) {
    const { fingerprint } = await f.scan(host);
    await f.pin(host, fingerprint);
  }
  const first = await f.list({ limit: "2" });
  assert.deepEqual(
    first.items.map(({ host, source }) => [host, source]),
    [
      ["bitbucket.org", HostKeySource.Keyscan],
      ["gitlab.com", HostKeySource.Keyscan],
    ],
  );
  assert.ok(first.next_cursor);
  const second = await f.list({ limit: "2", cursor: first.next_cursor! });
  assert.deepEqual(
    second.items.map(({ host, source }) => [host, source]),
    [["ssh.github.com", HostKeySource.GitHubMeta]],
  );
  assert.equal(second.next_cursor, null);
  assert.equal(second.items.length, LAST_PAGE_ITEMS);
  await assert.rejects(f.list({ cursor: "!" }), (error) =>
    fails(error, HttpStatus.BadRequest, "system.pagination.cursor_invalid"),
  );
});
