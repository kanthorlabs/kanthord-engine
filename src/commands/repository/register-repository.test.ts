import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AesGcmCrypto } from "../../services/crypto/aes-gcm.ts";
import type { Crypto } from "../../services/crypto/index.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type {
  Git,
  GitCredential,
  GitError,
  HostKey,
  RemoteUrlVerdict,
} from "../../services/git/index.ts";
import { GitError as GitErrorValue } from "../../services/git/index.ts";
import {
  parsePayload,
  serializePayload,
} from "../../domain/provider-payload.ts";
import {
  CREDENTIAL_SQL,
  RegisterRepositoryError,
  registerRepository,
} from "./register-repository.ts";
import type { RegisterRepositoryDependencies } from "./register-repository.ts";
import { assertNoOutsideWriter } from "./assert-no-outside-writer.ts";
import { CREDENTIAL_SQL as QUERY_CREDENTIAL_SQL } from "../../queries/repository/inspect-repository.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import { fixtureIds, seedRegistry } from "../../../test/helpers/rows.ts";

type ConfirmOutcome =
  | Readonly<{ confirmed: true; hostKey: HostKey }>
  | Readonly<{
      confirmed: false;
      reason: "fingerprint-mismatch" | "scan-failed";
      presented: readonly string[];
      detail: string;
    }>;

type RecordedSeed = Readonly<{
  gitDir: string;
  remoteUrl: string;
  branch: string;
  credential: GitCredential;
  hostKey: HostKey | null;
  pidFile: string;
}>;

type RepositoryRowReadback = Readonly<{
  id: string;
  name: string;
  remote_url: string;
  credential_id: string;
  home_path: string;
  branch: string;
  publish_on_approval: number;
  state: string;
  diverged_landing_oid: string | null;
  diverged_upstream_oid: string | null;
  fetched_upstream_oid: string | null;
  updated_at: number;
}>;

type GitOperationRowReadback = Readonly<{
  id: string;
  repository_id: string;
  intent: string;
  node_id: string | null;
  run_id: string | null;
  candidate_id: string | null;
  lease_fence: number;
  ref: string;
  base_oid: string;
  proposed_head_oid: string;
  result_head_oid: string | null;
  expected_remote_oid: string | null;
  state: string;
  outcome: string | null;
  detail_blob: string | null;
  child_token: string | null;
  completed_at: number | null;
}>;

type EventRowReadback = Readonly<{
  id: string;
  subject_kind: string;
  subject_id: string;
  type: string;
  actor_kind: string;
  actor_id: string;
  payload_json: string;
}>;

type MockView = Readonly<{
  id: string;
  name: string;
  remoteUrl: string;
  credential: Readonly<{ id: string; name: string }>;
  branch: string;
  landingRef: string;
  trackingRef: string;
  publishRef: string;
  publishOnApproval: boolean;
  state: "ready" | "needs-reconcile";
  landingOid: string | null;
  trackingOid: string | null;
  fetchedUpstreamOid: string | null;
  divergedLandingOid: string | null;
  divergedUpstreamOid: string | null;
  updatedAt: number;
}>;

const PROVIDER_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const REPO_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1A";
const GITOP_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1B";
const EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1C";
const providerId = `provider_${PROVIDER_ULID}`;
const repositoryId = `repo_${REPO_ULID}`;

const httpsUrl = "https://github.com/kanthorlabs/kanthord-verify.git";
const sshUrl = "ssh://git@github.com/kanthorlabs/kanthord-verify.git";
const token = "ghp_token";
const LANDING_OID = "1".repeat(40);
const FETCHED_OID = "f".repeat(40);

const crypto: Crypto = new AesGcmCrypto({
  key: Buffer.alloc(32, 7),
  keyVersion: 1,
});

const gitHttpBasicPayload = {
  transport: "http-basic",
  forge: "github",
  username: "x-access-token",
  token,
} as const;

const baseInput = {
  name: "kanthord-verify",
  remoteUrl: httpsUrl,
  credentialId: providerId,
  branch: "main",
  publishOnApproval: true,
  hostFingerprint: null,
  actor: "ulrich",
} as const;

function generateKey(file: string): string {
  execFileSync(
    resolveTools().paths.sshKeygen,
    ["-t", "ed25519", "-N", "", "-f", file],
    { env: {}, encoding: "utf8" },
  );
  return readFileSync(file, "utf8");
}

function seedProvider(
  storage: Storage,
  input: Readonly<{
    id: string;
    name: string;
    kind?: "git" | "llm";
    payload: unknown;
  }>,
): void {
  const kind = input.kind ?? "git";
  const plaintext =
    kind === "git"
      ? serializePayload("git", parsePayload("git", input.payload))
      : serializePayload("llm", parsePayload("llm", input.payload));
  const sealed = crypto.seal(plaintext);
  storage.transact((transaction) =>
    transaction.run(
      "INSERT INTO provider (id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        input.id,
        input.name,
        kind,
        null,
        sealed.ciphertext,
        sealed.iv,
        sealed.tag,
        sealed.keyVersion,
        1700000000000,
      ],
    ),
  );
}

function gitMock(
  overrides?: Readonly<{
    verdict?: RemoteUrlVerdict;
    confirm?: ConfirmOutcome;
    resolved?: string | null;
    seedError?: GitError;
  }>,
): Readonly<{
  git: Git;
  seedInputs: RecordedSeed[];
  confirmCalls: Readonly<{ remoteUrl: string; hostFingerprint: string }>[];
  trustCalls: Readonly<{ remoteUrl: string }>[];
  refCalls: Readonly<{ gitDir: string; ref: string }>[];
}> {
  const seedInputs: RecordedSeed[] = [];
  const confirmCalls: { remoteUrl: string; hostFingerprint: string }[] = [];
  const trustCalls: { remoteUrl: string }[] = [];
  const refCalls: { gitDir: string; ref: string }[] = [];
  const git: Git = {
    remoteUrlVerdict(remoteUrl: string): RemoteUrlVerdict {
      return (
        overrides?.verdict ?? {
          allowed: true,
          transport: remoteUrl.startsWith("ssh") ? "ssh" : "http-basic",
          host: "github.com",
        }
      );
    },
    async confirmHostKey(
      input: Readonly<{ remoteUrl: string; hostFingerprint: string }>,
    ): Promise<ConfirmOutcome> {
      confirmCalls.push(input);
      if (overrides?.confirm === undefined) {
        throw new Error("unexpected confirmHostKey call");
      }
      return overrides.confirm;
    },
    async trustHostKey(
      input: Readonly<{ remoteUrl: string; hostKey: HostKey }>,
    ): Promise<void> {
      trustCalls.push({ remoteUrl: input.remoteUrl });
    },
    async seedHome(input: {
      gitDir: string;
      remoteUrl: string;
      branch: string;
      credential: GitCredential;
      hostKey: HostKey | null;
      pidFile: string;
    }): Promise<{
      homePath: string;
      fetchedUpstreamOid: string;
      landingOid: string;
    }> {
      seedInputs.push({
        gitDir: input.gitDir,
        remoteUrl: input.remoteUrl,
        branch: input.branch,
        credential: input.credential,
        hostKey: input.hostKey,
        pidFile: input.pidFile,
      });
      if (overrides?.seedError !== undefined) {
        throw overrides.seedError;
      }
      mkdirSync(input.gitDir, { recursive: true });
      return {
        homePath: input.gitDir,
        fetchedUpstreamOid: FETCHED_OID,
        landingOid: LANDING_OID,
      };
    },
    async resolveRef(
      input: Readonly<{ gitDir: string; ref: string }>,
    ): Promise<string | null> {
      refCalls.push(input);
      if (overrides?.resolved !== undefined) {
        return overrides.resolved;
      }
      return LANDING_OID;
    },
    scanHostKeys(): Promise<never> {
      throw new Error("unexpected scanHostKeys call");
    },
    remoteInfo(): Promise<never> {
      throw new Error("unexpected remoteInfo call");
    },
    canPush(): Promise<never> {
      throw new Error("unexpected canPush call");
    },
    probePush(): Promise<never> {
      throw new Error("unexpected probePush call");
    },
    fetch(): Promise<never> {
      throw new Error("unexpected fetch call");
    },
    refUpdate(): Promise<never> {
      throw new Error("unexpected refUpdate call");
    },
    checkOutsideWriter(): Promise<never> {
      throw new Error("unexpected checkOutsideWriter call");
    },
    clone(): Promise<never> {
      throw new Error("unexpected clone call");
    },
    inspectChild(): Promise<never> {
      throw new Error("unexpected inspectChild call");
    },
    stopChild(): Promise<never> {
      throw new Error("unexpected stopChild call");
    },
    listPidFiles(): Promise<never> {
      throw new Error("unexpected listPidFiles call");
    },
    removePidFile(): Promise<never> {
      throw new Error("unexpected removePidFile call");
    },
    sweepHome(): Promise<never> {
      throw new Error("unexpected sweepHome call");
    },
    worktreeClean(): Promise<never> {
      throw new Error("unexpected worktreeClean call");
    },
  };
  return { git, seedInputs, confirmCalls, trustCalls, refCalls };
}

function rowCounts(storage: Storage): Readonly<{
  repository: number;
  gitOperation: number;
  event: number;
}> {
  return storage.transact((transaction) => {
    const repository = (
      transaction.get("SELECT COUNT(*) AS c FROM repository") as { c: number }
    ).c;
    const gitOperation = (
      transaction.get("SELECT COUNT(*) AS c FROM git_operation") as {
        c: number;
      }
    ).c;
    const event = (
      transaction.get("SELECT COUNT(*) AS c FROM event") as { c: number }
    ).c;
    return { repository, gitOperation, event };
  });
}

function readRepository(
  storage: Storage,
  id: string,
): RepositoryRowReadback | undefined {
  return storage.transact((transaction) =>
    transaction.get(
      "SELECT id, name, remote_url, credential_id, home_path, branch, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at FROM repository WHERE id = ?",
      [id],
    ),
  ) as RepositoryRowReadback | undefined;
}

function readGitOperation(
  storage: Storage,
  id: string,
): GitOperationRowReadback | undefined {
  return storage.transact((transaction) =>
    transaction.get(
      "SELECT id, repository_id, intent, node_id, run_id, candidate_id, lease_fence, ref, base_oid, proposed_head_oid, result_head_oid, expected_remote_oid, state, outcome, detail_blob, child_token, completed_at FROM git_operation WHERE id = ?",
      [id],
    ),
  ) as GitOperationRowReadback | undefined;
}

function readEvents(storage: Storage): readonly EventRowReadback[] {
  return storage.transact((transaction) =>
    transaction.all(
      "SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event",
    ),
  ) as readonly EventRowReadback[];
}

describe("src/commands/repository/register-repository.test", () => {
  const homeRoot = mkdtempSync(join(tmpdir(), "kanthord-register-repo-home-"));
  const keyDirectory = mkdtempSync(
    join(tmpdir(), "kanthord-register-repo-key-"),
  );
  let plainKey = "";

  before(() => {
    plainKey = generateKey(join(keyDirectory, "plain"));
  });

  after(() => {
    rmSync(homeRoot, { recursive: true, force: true });
    rmSync(keyDirectory, { recursive: true, force: true });
  });

  function dependencies(
    storage: Storage,
    ids: IdGenerator,
    clock: Clock,
    overrides?: Readonly<{
      git?: Git;
      events?: EventLog;
      readRepositoryView?: (id: string) => Promise<MockView | null>;
    }>,
  ): Readonly<{
    deps: RegisterRepositoryDependencies;
    viewCalls: string[];
  }> {
    const viewCalls: string[] = [];
    const view: MockView = {
      id: repositoryId,
      name: "kanthord-verify",
      remoteUrl: httpsUrl,
      credential: { id: providerId, name: "github-bot" },
      branch: "main",
      landingRef: "refs/heads/main",
      trackingRef: "refs/remotes/origin/main",
      publishRef: "refs/heads/main",
      publishOnApproval: true,
      state: "ready",
      landingOid: LANDING_OID,
      trackingOid: LANDING_OID,
      fetchedUpstreamOid: FETCHED_OID,
      divergedLandingOid: null,
      divergedUpstreamOid: null,
      updatedAt: 1700000000000,
    };
    return {
      deps: {
        storage,
        crypto,
        ids,
        clock,
        events: overrides?.events ?? new SqliteEventLog({ storage, ids }),
        git: overrides?.git ?? gitMock().git,
        readRepositoryView:
          overrides?.readRepositoryView ??
          (async (id: string): Promise<MockView | null> => {
            viewCalls.push(id);
            return view;
          }),
        homeRoot,
      },
      viewCalls,
    };
  }

  it("registers an http-basic repository with the baseline row and the event", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage, {
      id: providerId,
      name: "github-bot",
      payload: gitHttpBasicPayload,
    });
    const ids = createMockIdGenerator({
      ulids: [REPO_ULID, GITOP_ULID, EVENT_ULID],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const mock = gitMock();
    const { deps, viewCalls } = dependencies(temporary.storage, ids, clock, {
      git: mock.git,
    });

    const result = await registerRepository(deps, baseInput);

    assert.deepEqual(result, {
      id: repositoryId,
      name: "kanthord-verify",
      remoteUrl: httpsUrl,
      credential: { id: providerId, name: "github-bot" },
      branch: "main",
      landingRef: "refs/heads/main",
      trackingRef: "refs/remotes/origin/main",
      publishRef: "refs/heads/main",
      publishOnApproval: true,
      state: "ready",
      landingOid: LANDING_OID,
      trackingOid: LANDING_OID,
      fetchedUpstreamOid: FETCHED_OID,
      divergedLandingOid: null,
      divergedUpstreamOid: null,
      updatedAt: 1700000000000,
    });
    assert.deepEqual(viewCalls, [repositoryId]);

    const row = readRepository(temporary.storage, repositoryId);
    assert.ok(row !== undefined, "the repository row exists");
    assert.equal(row.id, repositoryId);
    assert.equal(row.name, "kanthord-verify");
    assert.equal(row.remote_url, httpsUrl);
    assert.equal(row.credential_id, providerId);
    assert.equal(row.home_path, join(homeRoot, "repos", "kanthord-verify.git"));
    assert.equal(row.branch, "main");
    assert.equal(row.publish_on_approval, 1);
    assert.equal(row.state, "ready");
    assert.equal(row.diverged_landing_oid, null);
    assert.equal(row.diverged_upstream_oid, null);
    assert.equal(row.fetched_upstream_oid, FETCHED_OID);
    assert.equal(row.updated_at, 1700000000000);

    const operations = storageRows(temporary.storage, "git_operation");
    assert.equal(operations, 1);
    const gitOp = readGitOperation(temporary.storage, `gitop_${GITOP_ULID}`);
    assert.ok(gitOp !== undefined, "the baseline git_operation row exists");
    assert.equal(gitOp.repository_id, repositoryId);
    assert.equal(gitOp.intent, "sync");
    assert.equal(gitOp.node_id, null);
    assert.equal(gitOp.run_id, null);
    assert.equal(gitOp.candidate_id, null);
    assert.equal(gitOp.lease_fence, 0);
    assert.equal(gitOp.ref, "refs/heads/main");
    assert.equal(gitOp.base_oid, LANDING_OID);
    assert.equal(gitOp.proposed_head_oid, LANDING_OID);
    assert.equal(gitOp.result_head_oid, LANDING_OID);
    assert.equal(gitOp.expected_remote_oid, null);
    assert.equal(gitOp.state, "complete");
    assert.equal(gitOp.outcome, null);
    assert.equal(gitOp.detail_blob, null);
    assert.equal(gitOp.child_token, null);
    assert.equal(gitOp.completed_at, 1700000000000);

    const events = readEvents(temporary.storage);
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.subject_kind, "repository");
    assert.equal(event.subject_id, repositoryId);
    assert.equal(event.type, "repository.registered");
    assert.equal(event.actor_kind, "human");
    assert.equal(event.actor_id, "ulrich");
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    assert.deepEqual(payload, {
      name: "kanthord-verify",
      branch: "main",
      publishOnApproval: true,
      credentialId: providerId,
      fetchedUpstreamOid: FETCHED_OID,
      landingOid: LANDING_OID,
    });
    assert.equal("remoteUrl" in payload, false);

    assert.deepEqual(mock.confirmCalls, []);
    assert.deepEqual(mock.trustCalls, []);
    assert.equal(mock.seedInputs.length, 1);
    const seed = mock.seedInputs[0]!;
    assert.equal(seed.hostKey, null);
    assert.equal(seed.branch, "main");
    assert.equal("publishRef" in seed, false);
    assert.equal(
      "landingBranch" in seed,
      false,
      "the seed carries one branch field",
    );
    assert.deepEqual(seed.credential, {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token,
    });
    assert.equal(
      seed.pidFile,
      join(homeRoot, "git", "run", `seed-${repositoryId}.pid`),
    );
  });

  it("publishOnApproval false writes publish_on_approval 0", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage, {
      id: providerId,
      name: "github-bot",
      payload: gitHttpBasicPayload,
    });
    const ids = createMockIdGenerator({
      ulids: [REPO_ULID, GITOP_ULID, EVENT_ULID],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const { deps } = dependencies(temporary.storage, ids, clock);

    await registerRepository(deps, {
      ...baseInput,
      publishOnApproval: false,
    });

    const row = readRepository(temporary.storage, repositoryId);
    assert.equal(row?.publish_on_approval, 0);
  });

  it("an ssh url seeds with the host key from the confirm outcome", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage, {
      id: providerId,
      name: "ssh-bot",
      payload: { transport: "ssh", privateKey: plainKey },
    });
    const ids = createMockIdGenerator({
      ulids: [REPO_ULID, GITOP_ULID, EVENT_ULID],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const confirmedKey: HostKey = {
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:confirmed-fp",
      publicKey: "SENTINEL-public-key",
    };
    const mock = gitMock({
      confirm: { confirmed: true, hostKey: confirmedKey },
    });
    const { deps } = dependencies(temporary.storage, ids, clock, {
      git: mock.git,
    });

    await registerRepository(deps, {
      ...baseInput,
      remoteUrl: sshUrl,
      hostFingerprint: "SHA256:confirmed-fp",
    });

    assert.deepEqual(mock.confirmCalls, [
      { remoteUrl: sshUrl, hostFingerprint: "SHA256:confirmed-fp" },
    ]);
    assert.deepEqual(mock.trustCalls, []);
    assert.equal(mock.seedInputs.length, 1);
    assert.deepEqual(mock.seedInputs[0]?.hostKey, confirmedKey);
    const row = readRepository(temporary.storage, repositoryId);
    assert.equal(row?.state, "ready");
  });

  it("a duplicate name refuses with name-taken and leaves the first rows unchanged", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage, {
      id: providerId,
      name: "github-bot",
      payload: gitHttpBasicPayload,
    });
    const ids = createMockIdGenerator({
      ulids: [
        REPO_ULID,
        GITOP_ULID,
        EVENT_ULID,
        "01HZY8QF3M4N5P6R7S8T9V0W1D",
        "01HZY8QF3M4N5P6R7S8T9V0W1E",
        "01HZY8QF3M4N5P6R7S8T9V0W1F",
      ],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const { deps } = dependencies(temporary.storage, ids, clock);

    await registerRepository(deps, baseInput);
    const before = rowCounts(temporary.storage);
    assert.deepEqual(before, { repository: 1, gitOperation: 1, event: 1 });

    const rejection = await registerRepository(deps, baseInput).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof RegisterRepositoryError, String(rejection));
    assert.equal(rejection.refusal, "name-taken");
    assert.deepEqual(rowCounts(temporary.storage), before);
  });

  it("an unknown credential id refuses with credential-not-found and writes nothing", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const { deps } = dependencies(temporary.storage, ids, clock);
    const before = rowCounts(temporary.storage);

    const rejection = await registerRepository(deps, {
      ...baseInput,
      credentialId: "provider_01HZY8QF3M4N5P6R7S8T9V0W0Z",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof RegisterRepositoryError, String(rejection));
    assert.equal(rejection.refusal, "credential-not-found");
    assert.deepEqual(rowCounts(temporary.storage), before);
  });

  it("an llm credential refuses with credential-wrong-kind naming the kind", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage, {
      id: providerId,
      name: "llm-bot",
      kind: "llm",
      payload: {
        provider: "openai",
        apiKey: "sk-x",
        defaultModel: "gpt-4",
        baseUrl: null,
      },
    });
    const ids = createMockIdGenerator({ ulids: [] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const { deps } = dependencies(temporary.storage, ids, clock);

    const rejection = await registerRepository(deps, baseInput).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof RegisterRepositoryError, String(rejection));
    assert.equal(rejection.refusal, "credential-wrong-kind");
    assert.ok(rejection.message.includes("llm"), rejection.message);
  });

  it("a tampered payload refuses with credential-unreadable and no crypto wording", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage, {
      id: providerId,
      name: "github-bot",
      payload: gitHttpBasicPayload,
    });
    temporary.storage.transact((transaction) =>
      transaction.run("UPDATE provider SET payload_tag = ? WHERE id = ?", [
        new Uint8Array(16),
        providerId,
      ]),
    );
    const ids = createMockIdGenerator({ ulids: [] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const { deps } = dependencies(temporary.storage, ids, clock);

    const rejection = await registerRepository(deps, baseInput).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof RegisterRepositoryError, String(rejection));
    assert.equal(rejection.refusal, "credential-unreadable");
    assert.equal(rejection.message.includes("authentication"), false);
    assert.equal(rejection.message.toLowerCase().includes("crypto"), false);
  });

  it("the two resolveGitCredential copies agree", () => {
    assert.equal(typeof CREDENTIAL_SQL, "string");
    assert.equal(CREDENTIAL_SQL, QUERY_CREDENTIAL_SQL);
  });

  it("an ssh url with hostFingerprint null refuses before any scan or seed", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage, {
      id: providerId,
      name: "ssh-bot",
      payload: { transport: "ssh", privateKey: plainKey },
    });
    const ids = createMockIdGenerator({ ulids: [] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const mock = gitMock();
    const { deps } = dependencies(temporary.storage, ids, clock, {
      git: mock.git,
    });

    const rejection = await registerRepository(deps, {
      ...baseInput,
      remoteUrl: sshUrl,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof RegisterRepositoryError, String(rejection));
    assert.equal(rejection.refusal, "host-fingerprint-required");
    assert.deepEqual(mock.confirmCalls, []);
    assert.deepEqual(mock.seedInputs, []);
    assert.deepEqual(rowCounts(temporary.storage), {
      repository: 0,
      gitOperation: 0,
      event: 0,
    });
  });

  it("an http-basic url with a hostFingerprint refuses with host-fingerprint-forbidden", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage, {
      id: providerId,
      name: "github-bot",
      payload: gitHttpBasicPayload,
    });
    const ids = createMockIdGenerator({ ulids: [] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const { deps } = dependencies(temporary.storage, ids, clock);

    const rejection = await registerRepository(deps, {
      ...baseInput,
      hostFingerprint: "SHA256:some-fingerprint",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof RegisterRepositoryError, String(rejection));
    assert.equal(rejection.refusal, "host-fingerprint-forbidden");
    assert.deepEqual(rowCounts(temporary.storage), {
      repository: 0,
      gitOperation: 0,
      event: 0,
    });
  });

  it("a fingerprint mismatch refuses with host-key-mismatch and seeds nothing", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage, {
      id: providerId,
      name: "ssh-bot",
      payload: { transport: "ssh", privateKey: plainKey },
    });
    const ids = createMockIdGenerator({ ulids: [] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const presented = ["SHA256:aaa", "SHA256:bbb"];
    const mock = gitMock({
      confirm: {
        confirmed: false,
        reason: "fingerprint-mismatch",
        presented,
        detail: "",
      },
    });
    const { deps } = dependencies(temporary.storage, ids, clock, {
      git: mock.git,
    });

    const rejection = await registerRepository(deps, {
      ...baseInput,
      remoteUrl: sshUrl,
      hostFingerprint: "SHA256:body-value",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof RegisterRepositoryError, String(rejection));
    assert.equal(rejection.refusal, "host-key-mismatch");
    assert.deepEqual(rejection.presented, presented);
    assert.equal(rejection.confirmed, "SHA256:body-value");
    assert.deepEqual(mock.trustCalls, []);
    assert.deepEqual(mock.seedInputs, []);
    assert.deepEqual(rowCounts(temporary.storage), {
      repository: 0,
      gitOperation: 0,
      event: 0,
    });
  });

  it("a scan failure refuses with host-key-unavailable and the detail", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage, {
      id: providerId,
      name: "ssh-bot",
      payload: { transport: "ssh", privateKey: plainKey },
    });
    const ids = createMockIdGenerator({ ulids: [] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const mock = gitMock({
      confirm: {
        confirmed: false,
        reason: "scan-failed",
        presented: [],
        detail: "github.com: Connection closed by remote host",
      },
    });
    const { deps } = dependencies(temporary.storage, ids, clock, {
      git: mock.git,
    });

    const rejection = await registerRepository(deps, {
      ...baseInput,
      remoteUrl: sshUrl,
      hostFingerprint: "SHA256:body-value",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof RegisterRepositoryError, String(rejection));
    assert.equal(rejection.refusal, "host-key-unavailable");
    assert.equal(
      rejection.detail,
      "github.com: Connection closed by remote host",
    );
    assert.deepEqual(rowCounts(temporary.storage), {
      repository: 0,
      gitOperation: 0,
      event: 0,
    });
  });

  it("a seedHome auth-failed propagates, writes no row and exactly one credentialRejected event", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage, {
      id: providerId,
      name: "github-bot",
      payload: gitHttpBasicPayload,
    });
    const ids = createMockIdGenerator({
      ulids: [REPO_ULID, EVENT_ULID],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const mock = gitMock({
      seedError: new GitErrorValue(
        "auth-failed",
        "the credential may not push to refs/heads/main",
        "remote: Invalid username or token",
      ),
    });
    const { deps } = dependencies(temporary.storage, ids, clock, {
      git: mock.git,
    });

    const rejection = await registerRepository(deps, baseInput).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof GitErrorValue, String(rejection));
    assert.equal(rejection.failure, "auth-failed");

    const counts = rowCounts(temporary.storage);
    assert.equal(counts.repository, 0);
    assert.equal(counts.gitOperation, 0);
    assert.equal(counts.event, 1);
    const events = readEvents(temporary.storage);
    const event = events[0]!;
    assert.equal(event.subject_kind, "provider");
    assert.equal(event.subject_id, providerId);
    assert.equal(event.type, "repository.register.credentialRejected");
    assert.equal(event.actor_kind, "human");
    assert.equal(event.actor_id, "ulrich");
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), [
      "credentialId",
      "failure",
      "name",
      "publishRef",
    ]);
    assert.deepEqual(payload, {
      failure: "auth-failed",
      name: "kanthord-verify",
      publishRef: "refs/heads/main",
      credentialId: providerId,
    });
    assert.equal("remoteUrl" in payload, false);
    assert.equal("detail" in payload, false);
  });

  it("a seedHome permission-denied writes exactly one credentialRejected event", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage, {
      id: providerId,
      name: "github-bot",
      payload: gitHttpBasicPayload,
    });
    const ids = createMockIdGenerator({
      ulids: [REPO_ULID, EVENT_ULID],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const mock = gitMock({
      seedError: new GitErrorValue(
        "permission-denied",
        "the credential may not push to refs/heads/main",
        "",
      ),
    });
    const { deps } = dependencies(temporary.storage, ids, clock, {
      git: mock.git,
    });

    const rejection = await registerRepository(deps, baseInput).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof GitErrorValue, String(rejection));
    assert.equal(rejection.failure, "permission-denied");

    const counts = rowCounts(temporary.storage);
    assert.equal(counts.repository, 0);
    assert.equal(counts.gitOperation, 0);
    assert.equal(counts.event, 1);
    const payload = JSON.parse(
      readEvents(temporary.storage)[0]!.payload_json,
    ) as Record<string, unknown>;
    assert.deepEqual(payload, {
      failure: "permission-denied",
      name: "kanthord-verify",
      publishRef: "refs/heads/main",
      credentialId: providerId,
    });
  });

  it("an unclassified seedHome failure writes no event", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage, {
      id: providerId,
      name: "github-bot",
      payload: gitHttpBasicPayload,
    });
    const ids = createMockIdGenerator({
      ulids: [REPO_ULID, "01HZY8QF3M4N5P6R7S8T9V0W1D"],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    for (const failure of ["transport-failed", "lock-held"] as const) {
      const mock = gitMock({
        seedError: new GitErrorValue(
          failure,
          "the seed failed",
          "unable to access",
        ),
      });
      const { deps } = dependencies(temporary.storage, ids, clock, {
        git: mock.git,
      });
      const rejection = await registerRepository(deps, baseInput).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(rejection instanceof GitErrorValue, String(rejection));
      assert.equal(rejection.failure, failure);
      assert.deepEqual(rowCounts(temporary.storage), {
        repository: 0,
        gitOperation: 0,
        event: 0,
      });
    }
  });

  it("a seedHome host-key-mismatch writes no row and no event", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage, {
      id: providerId,
      name: "github-bot",
      payload: gitHttpBasicPayload,
    });
    const ids = createMockIdGenerator({ ulids: [REPO_ULID] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const mock = gitMock({
      seedError: new GitErrorValue(
        "host-key-mismatch",
        "the host key changed",
        "",
      ),
    });
    const { deps } = dependencies(temporary.storage, ids, clock, {
      git: mock.git,
    });

    const rejection = await registerRepository(deps, baseInput).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof GitErrorValue, String(rejection));
    assert.equal(rejection.failure, "host-key-mismatch");
    assert.deepEqual(rowCounts(temporary.storage), {
      repository: 0,
      gitOperation: 0,
      event: 0,
    });
  });

  it("a failed transaction leaves an orphan visible home", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage, {
      id: providerId,
      name: "github-bot",
      payload: gitHttpBasicPayload,
    });
    const ids = createMockIdGenerator({ ulids: [REPO_ULID, GITOP_ULID] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const throwingEvents: EventLog = {
      append() {
        throw new Error("append failed");
      },
      list() {
        return [];
      },
    };
    const { deps } = dependencies(temporary.storage, ids, clock, {
      events: throwingEvents,
    });
    const homePath = join(homeRoot, "repos", "kanthord-verify.git");

    const rejection = await registerRepository(deps, baseInput).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof Error, String(rejection));
    assert.equal(rejection.message, "append failed");
    assert.deepEqual(rowCounts(temporary.storage), {
      repository: 0,
      gitOperation: 0,
      event: 0,
    });
    assert.equal(existsSync(homePath), true);
  });

  it("a refused url throws before the credential is read", async (t) => {
    const temporary = createMigratedStorage();
    const ids = createMockIdGenerator({ ulids: [] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const mock = gitMock({
      verdict: {
        allowed: false,
        refusal: "scheme-not-allowed",
        reason: "the scheme ftp is not allowed",
      },
    });
    const { deps } = dependencies(temporary.storage, ids, clock, {
      git: mock.git,
    });
    temporary.dispose();

    const rejection = await registerRepository(deps, {
      ...baseInput,
      remoteUrl: "ftp://example.com/r.git",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof GitErrorValue, String(rejection));
    assert.equal(rejection.failure, "url-refused");
  });
});

describe("src/commands/repository/register-repository.test — assertNoOutsideWriter", () => {
  const X = "x".repeat(40);
  const Y = "y".repeat(40);
  const Z = "z".repeat(40);

  function baselineInsert(
    transaction: Transaction,
    id: string,
    resultHeadOid: string,
    intent: "sync" | "publish" = "sync",
    completedAt = 1700000000000,
  ): void {
    transaction.run(
      "INSERT INTO git_operation (id, repository_id, intent, node_id, run_id, candidate_id, lease_fence, ref, base_oid, proposed_head_oid, result_head_oid, expected_remote_oid, state, outcome, detail_blob, child_token, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        fixtureIds.repository,
        intent,
        null,
        null,
        null,
        0,
        "refs/heads/main",
        X,
        X,
        resultHeadOid,
        null,
        "complete",
        null,
        null,
        null,
        completedAt,
      ],
    );
  }

  function outsideInput(
    overrides?: Readonly<{
      ref?: string;
      intent?: "merge" | "sync" | "publish" | "revert";
    }>,
  ) {
    return {
      repositoryId: fixtureIds.repository,
      gitDir: "repos/r.git",
      ref: overrides?.ref ?? "refs/heads/main",
      intent: overrides?.intent ?? "sync",
      actor: "ulrich",
    };
  }

  it("a matching baseline writes no event", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      baselineInsert(transaction, "g1", X);
    });
    const ids = createMockIdGenerator({ ulids: [] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const mock = gitMock({ resolved: X });
    const deps: RegisterRepositoryDependencies = {
      storage: temporary.storage,
      crypto,
      ids,
      clock,
      events: new SqliteEventLog({ storage: temporary.storage, ids }),
      git: mock.git,
      readRepositoryView: async () => null,
      homeRoot: join(tmpdir(), "kanthord-nowhere"),
    };

    const verdict = await assertNoOutsideWriter(deps, outsideInput());

    assert.deepEqual(verdict, {
      expected: true,
      expectedOid: X,
      observedOid: X,
    });
    assert.deepEqual(mock.refCalls, [
      { gitDir: "repos/r.git", ref: "refs/heads/main" },
    ]);
    const counts = rowCounts(temporary.storage);
    assert.equal(counts.event, 0);
  });

  it("a mismatch writes exactly one outsideWriter event in the same transaction", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      baselineInsert(transaction, "g1", X);
    });
    const ids = createMockIdGenerator({ ulids: [EVENT_ULID] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const mock = gitMock({ resolved: Y });
    const deps: RegisterRepositoryDependencies = {
      storage: temporary.storage,
      crypto,
      ids,
      clock,
      events: new SqliteEventLog({ storage: temporary.storage, ids }),
      git: mock.git,
      readRepositoryView: async () => null,
      homeRoot: join(tmpdir(), "kanthord-nowhere"),
    };

    const verdict = await assertNoOutsideWriter(deps, outsideInput());

    assert.deepEqual(verdict, {
      expected: false,
      expectedOid: X,
      observedOid: Y,
    });
    const events = readEvents(temporary.storage);
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.subject_kind, "repository");
    assert.equal(event.subject_id, fixtureIds.repository);
    assert.equal(event.type, "repository.outsideWriter");
    assert.deepEqual(JSON.parse(event.payload_json), {
      ref: "refs/heads/main",
      intent: "sync",
      expectedOid: X,
      observedOid: Y,
    });
  });

  it("a repeated mismatch writes one event per decision", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      baselineInsert(transaction, "g1", X);
    });
    const ids = createMockIdGenerator({
      ulids: [EVENT_ULID, "01HZY8QF3M4N5P6R7S8T9V0W1D"],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const mock = gitMock({ resolved: Y });
    const deps: RegisterRepositoryDependencies = {
      storage: temporary.storage,
      crypto,
      ids,
      clock,
      events: new SqliteEventLog({ storage: temporary.storage, ids }),
      git: mock.git,
      readRepositoryView: async () => null,
      homeRoot: join(tmpdir(), "kanthord-nowhere"),
    };

    await assertNoOutsideWriter(deps, outsideInput());
    await assertNoOutsideWriter(deps, outsideInput());

    const events = readEvents(temporary.storage);
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.type, "repository.outsideWriter");
    }
  });

  it("neither path sets needs-reconcile", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      baselineInsert(transaction, "g1", X);
    });
    const ids = createMockIdGenerator({ ulids: [EVENT_ULID] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const mock = gitMock({ resolved: Y });
    const deps: RegisterRepositoryDependencies = {
      storage: temporary.storage,
      crypto,
      ids,
      clock,
      events: new SqliteEventLog({ storage: temporary.storage, ids }),
      git: mock.git,
      readRepositoryView: async () => null,
      homeRoot: join(tmpdir(), "kanthord-nowhere"),
    };

    await assertNoOutsideWriter(deps, outsideInput());

    const row = temporary.storage.transact((transaction) =>
      transaction.get(
        "SELECT state, diverged_landing_oid, diverged_upstream_oid FROM repository WHERE id = ?",
        [fixtureIds.repository],
      ),
    ) as {
      state: string;
      diverged_landing_oid: string | null;
      diverged_upstream_oid: string | null;
    };
    assert.equal(row.state, "ready");
    assert.equal(row.diverged_landing_oid, null);
    assert.equal(row.diverged_upstream_oid, null);
  });

  it("the event survives a caller's refusal", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      baselineInsert(transaction, "g1", X);
    });
    const ids = createMockIdGenerator({ ulids: [EVENT_ULID] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const mock = gitMock({ resolved: Y });
    const deps: RegisterRepositoryDependencies = {
      storage: temporary.storage,
      crypto,
      ids,
      clock,
      events: new SqliteEventLog({ storage: temporary.storage, ids }),
      git: mock.git,
      readRepositoryView: async () => null,
      homeRoot: join(tmpdir(), "kanthord-nowhere"),
    };

    await assert.rejects(
      (async () => {
        const verdict = await assertNoOutsideWriter(deps, outsideInput());
        if (!verdict.expected) {
          throw new RegisterRepositoryError(
            "outside-writer",
            "the repository ref moved outside the daemon",
            {
              expectedOid: verdict.expectedOid,
              observedOid: verdict.observedOid,
            },
          );
        }
        return verdict;
      })(),
      (error: unknown) =>
        error instanceof RegisterRepositoryError &&
        error.refusal === "outside-writer",
    );

    const events = readEvents(temporary.storage);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "repository.outsideWriter");
  });

  it("two rows completing in one millisecond are ordered by identity", async (t) => {
    for (const order of [
      ["g1", "g2"],
      ["g2", "g1"],
    ] as const) {
      const temporary = createMigratedStorage();
      t.after(() => temporary.dispose());
      temporary.storage.transact((transaction) => {
        seedRegistry(transaction);
        for (const id of order) {
          baselineInsert(transaction, id, id === "g1" ? X : Z);
        }
      });
      const ids = createMockIdGenerator({ ulids: [EVENT_ULID] });
      const clock = createMockClock({ start: 1700000000000, step: 1000 });
      const mock = gitMock({ resolved: Y });
      const deps: RegisterRepositoryDependencies = {
        storage: temporary.storage,
        crypto,
        ids,
        clock,
        events: new SqliteEventLog({ storage: temporary.storage, ids }),
        git: mock.git,
        readRepositoryView: async () => null,
        homeRoot: join(tmpdir(), "kanthord-nowhere"),
      };

      const verdict = await assertNoOutsideWriter(deps, outsideInput());
      assert.equal(verdict.expected, false);
      assert.equal(
        verdict.expectedOid,
        Z,
        `the higher id wins in ${order.join(",")}`,
      );
    }
  });

  it("a row of another intent is not a baseline", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      baselineInsert(transaction, "g1", X);
      baselineInsert(transaction, "g2", Z, "publish", 1700000000001);
    });
    const ids = createMockIdGenerator({ ulids: [EVENT_ULID] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const mock = gitMock({ resolved: Y });
    const deps: RegisterRepositoryDependencies = {
      storage: temporary.storage,
      crypto,
      ids,
      clock,
      events: new SqliteEventLog({ storage: temporary.storage, ids }),
      git: mock.git,
      readRepositoryView: async () => null,
      homeRoot: join(tmpdir(), "kanthord-nowhere"),
    };

    const verdict = await assertNoOutsideWriter(deps, outsideInput());
    assert.deepEqual(verdict, {
      expected: false,
      expectedOid: X,
      observedOid: Y,
    });
  });
});

function storageRows(
  storage: Storage,
  table: "repository" | "git_operation",
): number {
  const row = storage.transact((transaction) =>
    transaction.get(`SELECT COUNT(*) AS c FROM ${table}`),
  ) as { c: number };
  return row.c;
}
