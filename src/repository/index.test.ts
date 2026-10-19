import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { Material } from "../custody/contract.ts";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { isolatedGitEnvironment } from "../kernel/git-environment.ts";
import { HttpStatus } from "../kernel/http.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { temporary } from "../kernel/test-support.ts";
import { HostKeyErrorCode, RepositoryErrorCode } from "./contract.ts";
import {
  RepositoryComponent,
  repositoryMigrations,
  type SshGrantFacts,
} from "./index.ts";
import { generateSshKey } from "./ssh-key.ts";
import {
  createBareRepository,
  DEFAULT_SSH_PORT,
  startTestSshd,
  TEST_REPOSITORY_FILE,
  TEST_REPOSITORY_TEXT,
} from "./test-sshd.ts";

const CREDENTIAL_ID = "credential_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREDENTIAL_NAME = "deploy";
const PLATFORM = "ssh";
const GITHUB_ADDRESS = "git@github.com:owner/repository.git";
const ALIAS_ADDRESS = "git@github:owner/repository.git";
const HOST_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const DEADLINE_MS = 30_000;
const ALTERNATIVE_PORT = 443;
const execFileAsync = promisify(execFile);
const ADDRESS_INVALID = "project.bindings.repository.address_invalid";
const CHECK_CALL = "check";
const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function granted(address: string): SshGrantFacts {
  return {
    project_id: PROJECT_ID,
    credential: CREDENTIAL_NAME,
    facts: { binding_id: null, address },
  };
}

delete process.env.SSH_AUTH_SOCK;
delete process.env.SSH_AGENT_PID;

function pinnedStore(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([{ service: "repository", migrations: repositoryMigrations }]);
  store.database
    .prepare(
      "INSERT INTO repository_host_key (id, host, public_key, created_at) VALUES ('host_key_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'github.com', ?, 1)",
    )
    .run(HOST_KEY);
  return store;
}

type HeldMaterial = Material & { dropped: () => boolean };

function material(secret: unknown): HeldMaterial {
  let dropped = false;
  return {
    credential_id: CREDENTIAL_ID,
    platform: PLATFORM,
    value: () => secret,
    drop: () => void (dropped = true),
    dropped: () => dropped,
  };
}

function refusal(status: number, code: string, details?: unknown) {
  return (error: unknown) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    if (details !== undefined) assert.deepEqual(error.details, details);
    return true;
  };
}

test("sshAccessOf builds the access from the key and the pin of the address host and drops the material", (t) => {
  const store = pinnedStore(t);
  const key = generateSshKey(CREDENTIAL_NAME);
  const held = material({ private_key: key.private_key });
  const access = store.transaction((tx) =>
    new RepositoryComponent().sshAccessOf(tx, granted(GITHUB_ADDRESS), held),
  );
  assert.deepEqual(access, {
    private_key: key.private_key,
    public_key: key.public_key,
    known_hosts: `github.com ${HOST_KEY}\n`,
    port: DEFAULT_SSH_PORT,
  });
  assert.ok(held.dropped());
});

test("sshAccessOf takes the port of an alternative SSH host from the fixed table and pins the bracket form", (t) => {
  const store = pinnedStore(t);
  for (const host of ["altssh.gitlab.com", "altssh.bitbucket.org"]) {
    store.database
      .prepare(
        "INSERT INTO repository_host_key (id, host, public_key, created_at) VALUES (?, ?, ?, 1)",
      )
      .run(`host_key_${host}`, host, HOST_KEY);
    const key = generateSshKey(CREDENTIAL_NAME);
    const access = store.transaction((tx) =>
      new RepositoryComponent().sshAccessOf(
        tx,
        granted(`git@${host}:owner/repository.git`),
        material({ private_key: key.private_key }),
      ),
    );
    assert.equal(
      access.known_hosts,
      `[${host}]:${ALTERNATIVE_PORT} ${HOST_KEY}\n`,
    );
    assert.equal(access.port, ALTERNATIVE_PORT);
  }
});

test("sshAccessOf refuses an unpinned host, an alias address and a legacy key by name and drops the material", (t) => {
  const store = pinnedStore(t);
  const key = generateSshKey(CREDENTIAL_NAME);
  const component = new RepositoryComponent();
  const cases: Array<[unknown, string, (error: unknown) => boolean]> = [
    [
      { private_key: key.private_key },
      "git@gitlab.com:owner/repository.git",
      refusal(HttpStatus.Conflict, HostKeyErrorCode.Unpinned, {
        host: "gitlab.com",
      }),
    ],
    [
      { private_key: key.private_key },
      "ssh://git@github.com/owner/repository.git",
      refusal(HttpStatus.BadRequest, ADDRESS_INVALID),
    ],
    [
      { private_key: key.private_key },
      ALIAS_ADDRESS,
      refusal(HttpStatus.Conflict, HostKeyErrorCode.Unpinned, {
        host: "github",
      }),
    ],
    [
      {},
      GITHUB_ADDRESS,
      refusal(HttpStatus.Conflict, RepositoryErrorCode.SshKeyLegacy, {
        credential: CREDENTIAL_NAME,
      }),
    ],
    [
      { private_key: "not an SSH key\n" },
      GITHUB_ADDRESS,
      refusal(HttpStatus.Conflict, RepositoryErrorCode.SshKeyLegacy, {
        credential: CREDENTIAL_NAME,
      }),
    ],
  ];
  for (const [secret, address, matches] of cases) {
    const held = material(secret);
    assert.throws(
      () =>
        store.transaction((tx) =>
          component.sshAccessOf(tx, granted(address), held),
        ),
      matches,
    );
    assert.ok(held.dropped());
  }
});

test("the known_hosts seam lets a test reach a local sshd on another port", async (t) => {
  const sshd = await startTestSshd(t);
  const bare = await createBareRepository(t);
  const key = generateSshKey(CREDENTIAL_NAME);
  await sshd.authorize(key.public_key);
  const addresses: string[] = [];
  const component = new RepositoryComponent({
    knownHostsOf: (_tx, address) => {
      addresses.push(address);
      return sshd.known_hosts;
    },
    portOf: () => sshd.port,
  });
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  const address = sshd.url(bare);
  const access = store.transaction((tx) =>
    component.sshAccessOf(
      tx,
      granted(address),
      material({ private_key: key.private_key }),
    ),
  );
  assert.deepEqual(addresses, [address]);
  const directory = join(temporary(t), "clone");
  await mkdir(directory);
  await component.clone(address, directory, background, DEADLINE_MS, access);
  const { stdout } = await execFileAsync(
    "git",
    ["show", `HEAD:${TEST_REPOSITORY_FILE}`],
    { cwd: directory, env: isolatedGitEnvironment(process.env) },
  );
  assert.equal(stdout, TEST_REPOSITORY_TEXT);
});

test("gitLsRemote of the component reaches a local sshd with the custody key", async (t) => {
  const sshd = await startTestSshd(t);
  const bare = await createBareRepository(t);
  const key = generateSshKey(CREDENTIAL_NAME);
  await sshd.authorize(key.public_key);
  const component = new RepositoryComponent();
  await component.gitLsRemote(sshd.url(bare), background, DEADLINE_MS, {
    private_key: key.private_key,
    public_key: key.public_key,
    known_hosts: sshd.known_hosts,
    port: sshd.port,
  });
});

test("the component runs the tool check of its dependencies once at construction", () => {
  const checks: string[] = [];
  new RepositoryComponent({ checkTools: () => void checks.push(CHECK_CALL) });
  assert.deepEqual(checks, [CHECK_CALL]);
});
