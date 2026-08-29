import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AesGcmCrypto } from "../../services/crypto/aes-gcm.ts";
import type { Crypto } from "../../services/crypto/index.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type {
  Git,
  GitCredential,
  GitError,
  HostKey,
  RemoteInfo,
  RemoteUrlVerdict,
} from "../../services/git/index.ts";
import { GitError as GitErrorValue } from "../../services/git/index.ts";
import {
  parsePayload,
  type GitPayload,
} from "../../domain/provider-payload.ts";
import { registerProvider } from "../../commands/provider/register-provider.ts";
import type { RegisterProviderDependencies } from "../../commands/provider/register-provider.ts";
import {
  inspectRepository,
  InspectRepositoryError,
  resolveGitCredential,
} from "./inspect-repository.ts";
import type { InspectRepositoryResult } from "./inspect-repository.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import { createFakeModelCatalog } from "../../../test/helpers/model-catalog.ts";

type ScanOutcome =
  | Readonly<{ scanned: true; hostKeys: readonly HostKey[] }>
  | Readonly<{
      scanned: false;
      failure: "host-key-unavailable" | "timed-out";
      detail: string;
    }>;

const httpsUrl = "https://github.com/kanthorlabs/kanthord-verify.git";
const sshUrl = "ssh://git@github.com/kanthorlabs/kanthord-verify.git";

const token = "ghp_token";

type ProbePushCall = Parameters<Git["probePush"]>[0];

const crypto: Crypto = new AesGcmCrypto({
  key: Buffer.alloc(32, 7),
  keyVersion: 1,
});

function generateKey(file: string): string {
  execFileSync(
    resolveTools().paths.sshKeygen,
    ["-t", "ed25519", "-N", "", "-f", file],
    {
      env: {},
      encoding: "utf8",
    },
  );
  return readFileSync(file, "utf8");
}

function deps(
  storage: Storage,
  ids: IdGenerator,
  clock: Clock,
): RegisterProviderDependencies {
  return {
    storage,
    crypto,
    ids,
    clock,
    events: new SqliteEventLog({ storage, ids }),
    catalog: createFakeModelCatalog(),
  };
}

function register(
  storage: Storage,
  name: string,
  kind: "git" | "llm",
  payload: unknown,
): string {
  const ids = createMockIdGenerator({
    ulids: [
      "01HZY8QF3M4N5P6R7S8T9V0W1X",
      "01HZY8QF3M4N5P6R7S8T9V0W1Y",
      "01HZY8QF3M4N5P6R7S8T9V0W1Z",
    ],
  });
  const clock = createMockClock({ start: 1700000000000, step: 1000 });
  return registerProvider(deps(storage, ids, clock), {
    name,
    kind,
    payload,
    actor: "ulrich",
  }).id;
}

function gitMock(
  overrides?: Readonly<{
    verdict?: RemoteUrlVerdict;
    info?: RemoteInfo;
    infoError?: GitError;
    scan?: ScanOutcome;
    probePush?: Git["probePush"];
  }>,
): Readonly<{
  git: Git;
  scanCalls: readonly string[];
  infoCalls: readonly { remoteUrl: string }[];
  probeCalls: readonly ProbePushCall[];
}> {
  const scanCalls: string[] = [];
  const infoCalls: { remoteUrl: string }[] = [];
  const probeCalls: ProbePushCall[] = [];
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
    async scanHostKeys(remoteUrl: string): Promise<ScanOutcome> {
      scanCalls.push(remoteUrl);
      return (
        overrides?.scan ?? {
          scanned: true,
          hostKeys: [
            {
              algorithm: "ssh-ed25519",
              fingerprint: "SHA256:first",
              publicKey: "AAAAfirst",
            },
            {
              algorithm: "ssh-rsa",
              fingerprint: "SHA256:second",
              publicKey: "BBBBsecond",
            },
          ],
        }
      );
    },
    async remoteInfo(
      input: Readonly<{ remoteUrl: string; credential: GitCredential }>,
    ): Promise<RemoteInfo> {
      infoCalls.push({ remoteUrl: input.remoteUrl });
      if (overrides?.infoError !== undefined) {
        throw overrides.infoError;
      }
      return overrides?.info ?? { defaultBranch: "main", branches: ["main"] };
    },
    confirmHostKey(): Promise<never> {
      throw new Error("unexpected confirmHostKey call");
    },
    trustHostKey(): Promise<void> {
      throw new Error("unexpected trustHostKey call");
    },
    seedHome(): Promise<never> {
      throw new Error("unexpected seedHome call");
    },
    canPush(): Promise<never> {
      throw new Error("unexpected canPush call");
    },
    probePush(input: ProbePushCall): ReturnType<Git["probePush"]> {
      probeCalls.push(input);
      if (overrides?.probePush !== undefined) {
        return overrides.probePush(input);
      }
      throw new Error("unexpected probePush call");
    },
    fetch(): Promise<void> {
      throw new Error("unexpected fetch call");
    },
    resolveRef(): Promise<never> {
      throw new Error("unexpected resolveRef call");
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
  return { git, scanCalls, infoCalls, probeCalls };
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

describe("src/queries/repository/inspect-repository.test", () => {
  const keyDirectory = mkdtempSync(join(tmpdir(), "kanthord-inspect-repo-"));
  let plainKey = "";

  before(() => {
    plainKey = generateKey(join(keyDirectory, "plain"));
  });

  after(() => {
    rmSync(keyDirectory, { recursive: true, force: true });
  });

  it("returns the read verdict for an https url with a git http-basic credential", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(temporary.storage, "github-bot", "git", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token,
    });
    const before = rowCounts(temporary.storage);
    const { git, infoCalls } = gitMock();
    const result = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: httpsUrl, credentialId: id },
    );
    assert.deepEqual(result, {
      defaultBranch: "main",
      branches: ["main"],
      credential: { reachable: true, refusal: null },
      hostKey: null,
      access: {
        read: { allowed: true, refusal: null },
        write: null,
      },
    });
    assert.deepEqual(infoCalls, [{ remoteUrl: httpsUrl }]);
    const after = rowCounts(temporary.storage);
    assert.deepEqual(after, before);
    assert.equal(after.repository, 0);
    assert.equal(after.gitOperation, 0);
    assert.equal(after.event, 1);
  });

  it("never calls scanHostKeys for an http-basic url", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(temporary.storage, "github-bot", "git", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token,
    });
    const { git, scanCalls } = gitMock();
    await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: httpsUrl, credentialId: id },
    );
    assert.deepEqual(scanCalls, []);
  });

  it("returns the first sorted host key for an ssh url", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(temporary.storage, "ssh-bot", "git", {
      transport: "ssh",
      privateKey: plainKey,
    });
    const hostKeys = [
      {
        algorithm: "ssh-ed25519",
        fingerprint: "SHA256:first",
        publicKey: "AAAA",
      },
      { algorithm: "ssh-rsa", fingerprint: "SHA256:second", publicKey: "BBBB" },
    ];
    const { git, scanCalls } = gitMock({
      scan: { scanned: true, hostKeys },
    });
    const result = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: sshUrl, credentialId: id },
    );
    assert.deepEqual(result.hostKey, hostKeys[0]);
    assert.deepEqual(
      Object.keys(result.hostKey as Record<string, unknown>).sort(),
      ["algorithm", "fingerprint", "publicKey"],
    );
    assert.deepEqual(scanCalls, [sshUrl]);
  });

  it("reports an auth-failed remoteInfo as a verdict, not a rejection", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(temporary.storage, "github-bot", "git", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token,
    });
    const { git } = gitMock({
      infoError: new GitErrorValue("auth-failed", "git ls-remote failed", ""),
    });
    const result = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: httpsUrl, credentialId: id },
    );
    assert.deepEqual(result, {
      defaultBranch: null,
      branches: [],
      credential: { reachable: false, refusal: "auth-failed" },
      hostKey: null,
      access: {
        read: { allowed: false, refusal: "auth-failed" },
        write: null,
      },
    });
  });

  it("carries a transport classification through the verdict unchanged", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(temporary.storage, "github-bot", "git", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token,
    });
    const { git } = gitMock({
      infoError: new GitErrorValue(
        "transport-failed",
        "git ls-remote failed",
        "",
      ),
    });
    const result = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: httpsUrl, credentialId: id },
    );
    assert.deepEqual(result.credential, {
      reachable: false,
      refusal: "transport-failed",
    });
  });

  it("refuses an unknown credential id with credential-not-found", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const { git } = gitMock();
    const rejection = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      {
        remoteUrl: httpsUrl,
        credentialId: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof InspectRepositoryError, String(rejection));
    assert.equal(rejection.refusal, "credential-not-found");
  });

  it("refuses an llm credential as credential-wrong-kind naming the kind", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(temporary.storage, "llm-bot", "llm", {
      provider: "openai",
      apiKey: "sk-x",
      defaultModel: "gpt-4",
      baseUrl: null,
    });
    const { git } = gitMock();
    const rejection = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: httpsUrl, credentialId: id },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof InspectRepositoryError, String(rejection));
    assert.equal(rejection.refusal, "credential-wrong-kind");
    assert.ok(rejection.message.includes(id), rejection.message);
    assert.ok(rejection.message.includes("llm"), rejection.message);
  });

  it("refuses a tampered payload as credential-unreadable and discards the crypto diagnostic", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(temporary.storage, "github-bot", "git", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token,
    });
    temporary.storage.transact((transaction) =>
      transaction.run("UPDATE provider SET payload_tag = ? WHERE id = ?", [
        new Uint8Array(16),
        id,
      ]),
    );
    const { git } = gitMock();
    const rejection = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: httpsUrl, credentialId: id },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof InspectRepositoryError, String(rejection));
    assert.equal(rejection.refusal, "credential-unreadable");
    assert.equal(rejection.message.includes("authentication"), false);
    assert.equal(rejection.message.toLowerCase().includes("crypto"), false);
  });

  it("maps a git payload to a git credential by construction", () => {
    const parsed = parsePayload("git", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token,
    }) as GitPayload;
    const credential: GitCredential = parsed;
    assert.deepEqual(Object.keys(credential).sort(), [
      "forge",
      "token",
      "transport",
      "username",
    ]);
    const parsedSsh = parsePayload("git", {
      transport: "ssh",
      privateKey: plainKey,
    }) as GitPayload;
    const credentialSsh: GitCredential = parsedSsh;
    assert.deepEqual(Object.keys(credentialSsh).sort(), [
      "privateKey",
      "transport",
    ]);
  });

  it("resolves an http-basic row to the identity-mapped credential shape", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(temporary.storage, "github-bot", "git", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token,
    });
    const credential = resolveGitCredential(
      { storage: temporary.storage, crypto },
      id,
    );
    assert.deepEqual(Object.keys(credential).sort(), [
      "forge",
      "token",
      "transport",
      "username",
    ]);
  });

  it("resolves an ssh row to the identity-mapped credential shape", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(temporary.storage, "ssh-bot", "git", {
      transport: "ssh",
      privateKey: plainKey,
    });
    const credential = resolveGitCredential(
      { storage: temporary.storage, crypto },
      id,
    );
    assert.deepEqual(Object.keys(credential).sort(), [
      "privateKey",
      "transport",
    ]);
  });

  it("reports an unavailable host key as host-key-unavailable with the detail", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(temporary.storage, "ssh-bot", "git", {
      transport: "ssh",
      privateKey: plainKey,
    });
    const { git } = gitMock({
      scan: {
        scanned: false,
        failure: "host-key-unavailable",
        detail: "example.com: Connection closed by remote host",
      },
    });
    const rejection = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: sshUrl, credentialId: id },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof InspectRepositoryError, String(rejection));
    assert.equal(rejection.refusal, "host-key-unavailable");
    assert.equal(
      rejection.detail,
      "example.com: Connection closed by remote host",
    );
  });

  it("refuses a refused url before calling remoteInfo", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(temporary.storage, "github-bot", "git", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token,
    });
    const { git, infoCalls } = gitMock({
      verdict: {
        allowed: false,
        refusal: "scheme-not-allowed",
        reason: "the scheme ftp is not allowed",
      },
    });
    const rejection = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: "ftp://example.com/r.git", credentialId: id },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof GitErrorValue, String(rejection));
    assert.equal(rejection.failure, "url-refused");
    assert.deepEqual(infoCalls, []);
  });

  it("never leaks the token or the private key into a result", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(temporary.storage, "github-bot", "git", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token,
    });
    const { git } = gitMock();
    const result = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: httpsUrl, credentialId: id },
    );
    assert.equal(JSON.stringify(result).includes(token), false);
  });

  it("omitting requiredAccess returns access.write null", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(temporary.storage, "github-bot", "git", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token,
    });
    const { git } = gitMock();
    const result = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: httpsUrl, credentialId: id },
    );
    assert.equal(result.access.write, null);
    assert.deepEqual(result.access.read, { allowed: true, refusal: null });
  });

  it("requiredAccess read behaves identically to omitting it", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(temporary.storage, "github-bot", "git", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token,
    });
    const { git } = gitMock();
    const omitted = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: httpsUrl, credentialId: id },
    );
    const read = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: httpsUrl, credentialId: id, requiredAccess: "read" },
    );
    assert.deepEqual(read, omitted);
    assert.equal(read.access.write, null);
    assert.deepEqual(read.access.read, { allowed: true, refusal: null });
  });

  it("requiredAccess write with writer credential returns both verdicts allowed", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(temporary.storage, "github-bot", "git", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token,
    });
    const { git, probeCalls } = gitMock({
      probePush: async () => ({ allowed: true as const }),
    });
    const result = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: httpsUrl, credentialId: id, requiredAccess: "write" },
    );
    assert.deepEqual(probeCalls, [
      {
        remoteUrl: httpsUrl,
        branch: "main",
        credential: {
          transport: "http-basic",
          forge: "github",
          username: "x-access-token",
          token,
        },
      },
    ]);
    assert.deepEqual(result.access.read, { allowed: true, refusal: null });
    assert.deepEqual(result.access.write, { allowed: true, refusal: null });
    assert.deepEqual(result.credential, { reachable: true, refusal: null });
  });

  it("requiredAccess write with push-refused credential returns write false", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(temporary.storage, "github-bot", "git", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token,
    });
    const { git } = gitMock({
      probePush: async () => ({
        allowed: false as const,
        failure: "auth-failed",
        detail: "",
      }),
    });
    const result = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: httpsUrl, credentialId: id, requiredAccess: "write" },
    );
    assert.deepEqual(result.access.read, { allowed: true, refusal: null });
    assert.deepEqual(result.access.write, {
      allowed: false,
      refusal: "auth-failed",
    });
    assert.equal(result.credential.reachable, true);
  });

  it("read failure short-circuits probe; write carries same refusal", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(temporary.storage, "github-bot", "git", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token,
    });
    const { git, probeCalls } = gitMock({
      infoError: new GitErrorValue("auth-failed", "remote read failed", ""),
      probePush: async () => {
        throw new Error("should not be called");
      },
    });
    const result = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: httpsUrl, credentialId: id, requiredAccess: "write" },
    );
    assert.equal(result.credential.reachable, false);
    assert.deepEqual(result.access.read, {
      allowed: false,
      refusal: "auth-failed",
    });
    assert.deepEqual(result.access.write, {
      allowed: false,
      refusal: "auth-failed",
    });
    assert.deepEqual(probeCalls, []);
  });

  it("empty-remote branch returns write false with empty-remote refusal", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(temporary.storage, "github-bot", "git", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token,
    });
    const { git, probeCalls } = gitMock({
      info: { defaultBranch: null, branches: [] },
      probePush: async () => ({
        allowed: false as const,
        failure: "empty-remote",
        detail: "",
      }),
    });
    const result = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: httpsUrl, credentialId: id, requiredAccess: "write" },
    );
    assert.deepEqual(result.access.write, {
      allowed: false,
      refusal: "empty-remote",
    });
    assert.equal(probeCalls.length, 1);
    assert.equal(probeCalls[0]?.branch, null);
  });

  it("read failure without requiredAccess write leaves access.write null", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(temporary.storage, "github-bot", "git", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token,
    });
    const { git } = gitMock({
      infoError: new GitErrorValue(
        "transport-failed",
        "remote read failed",
        "",
      ),
    });
    const result = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: httpsUrl, credentialId: id },
    );
    assert.equal(result.access.write, null);
    assert.deepEqual(result.access.read, {
      allowed: false,
      refusal: "transport-failed",
    });
  });

  it("probePush throws GitError (fetch fails) and query converts to write verdict", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const stderrSentinel = "raw-git-stderr-sentinel-epic-043";
    const id = register(temporary.storage, "github-bot", "git", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token,
    });
    const { git } = gitMock({
      probePush: async () => {
        throw new GitErrorValue(
          "auth-failed",
          "probe fetch failed",
          stderrSentinel,
        );
      },
    });
    const result = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: httpsUrl, credentialId: id, requiredAccess: "write" },
    );
    assert.deepEqual(result.access.write, {
      allowed: false,
      refusal: "auth-failed",
    });
    assert.deepEqual(result.access.read, { allowed: true, refusal: null });
    assert.equal(JSON.stringify(result).includes(stderrSentinel), false);
  });

  it("no token or private key in serialized result when requiredAccess write", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const sshTemporary = createMigratedStorage();
    t.after(() => sshTemporary.dispose());
    const httpId = register(temporary.storage, "github-bot", "git", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token,
    });
    const sshId = register(sshTemporary.storage, "ssh-bot", "git", {
      transport: "ssh",
      privateKey: plainKey,
    });
    const { git } = gitMock({
      probePush: async () => ({ allowed: true as const }),
    });
    const result = await inspectRepository(
      { storage: temporary.storage, crypto, git },
      { remoteUrl: httpsUrl, credentialId: httpId, requiredAccess: "write" },
    );
    const sshResult = await inspectRepository(
      { storage: sshTemporary.storage, crypto, git },
      { remoteUrl: sshUrl, credentialId: sshId, requiredAccess: "write" },
    );
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(JSON.stringify(sshResult).includes(plainKey), false);
  });
});
