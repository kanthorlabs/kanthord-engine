import assert from "node:assert/strict";
import { once } from "node:events";
import { type AddressInfo, createServer, type Socket } from "node:net";
import test from "node:test";
import { background, DeadlineExceeded } from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { ResourceFailureReason } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { gitLsRemote, GitStage, GitWriteError } from "./connector.ts";
import { HostKeyErrorCode, RepositoryErrorCode } from "./contract.ts";
import { classifyGitFailure, gitFailureReason } from "./git-failure.ts";
import { SshAgentErrorCode } from "./ssh-agent.ts";
import { generateSshKey } from "./ssh-key.ts";
import {
  createBareRepository,
  LOCAL_GIT_SSH_ACCESS,
  startTestSshd,
} from "./sshd-test-support.ts";

const GIT_FAILED = "repository.connector.git_failed";
const DEADLINE_MS = 60_000;
const SILENT_HOST_DEADLINE_MS = 3000;
const SILENT_HOST = "127.0.0.1";
const MISSING_REPOSITORY = "file:////nonexistent_kanthord_git_failure_test";
const READ_FAILED =
  "fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.";
const READ_FAILED_GERMAN =
  "fatal: Konnte nicht vom Remote-Repository lesen.\n\nBitte stellen Sie sicher, dass die korrekten Zugriffsrechte bestehen\nund das Repository existiert.";

function lsRemoteFailure(stderr: string): string {
  return `ls-remote: git exited with 128: ${stderr}`;
}

function connectorFailure(stderr: string): Diagnostic {
  return new Diagnostic(GIT_FAILED, "ls-remote: git failed.", {
    cause: new Error(lsRemoteFailure(stderr)),
  });
}

test("classifyGitFailure names each git failure reason from its OpenSSH or remote line", () => {
  const samples: Array<[string, ResourceFailureReason]> = [
    [
      `Host key verification failed.\n${READ_FAILED}`,
      ResourceFailureReason.HostKeyUnknown,
    ],
    [
      `git@github.com: Permission denied (publickey).\n${READ_FAILED}`,
      ResourceFailureReason.KeyRefused,
    ],
    [
      `ERROR: Repository not found.\n${READ_FAILED}`,
      ResourceFailureReason.RepositoryNotFound,
    ],
    [
      `ssh: Could not resolve hostname gitlab.invalid: nodename nor servname provided, or not known\n${READ_FAILED}`,
      ResourceFailureReason.HostUnreachable,
    ],
    [
      `ssh: connect to host github.com port 22: Connection timed out\n${READ_FAILED}`,
      ResourceFailureReason.HostUnreachable,
    ],
    [
      `ssh: connect to host 127.0.0.1 port 22: Connection refused\n${READ_FAILED}`,
      ResourceFailureReason.HostUnreachable,
    ],
    [
      `ssh: connect to host github.com port 22: Operation timed out\n${READ_FAILED}`,
      ResourceFailureReason.HostUnreachable,
    ],
    [
      `ssh: connect to host github.com port 22: No route to host\n${READ_FAILED}`,
      ResourceFailureReason.HostUnreachable,
    ],
    [
      `ssh: connect to host github.com port 22: Network is unreachable\n${READ_FAILED}`,
      ResourceFailureReason.HostUnreachable,
    ],
    [
      `remote: \nremote: ========================================================================\nremote: \nremote: The project you were looking for could not be found or you don't have permission to view it.\nremote: \nremote: ========================================================================\nremote: \n${READ_FAILED}`,
      ResourceFailureReason.RepositoryNotFound,
    ],
    [READ_FAILED, ResourceFailureReason.Unclassified],
  ];
  for (const [stderr, reason] of samples)
    assert.equal(classifyGitFailure(lsRemoteFailure(stderr)), reason);
});

test("classifyGitFailure answers host_key_changed for a changed host key before the host key line", () => {
  assert.equal(
    classifyGitFailure(
      lsRemoteFailure(
        `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nHost key verification failed.\n${READ_FAILED}`,
      ),
    ),
    ResourceFailureReason.HostKeyChanged,
  );
});

test("gitFailureReason answers identity_unavailable for an SSH agent failure and a legacy SSH record", () => {
  assert.equal(
    gitFailureReason(
      new Diagnostic(SshAgentErrorCode.Failed, "load: SSH agent failed.", {
        cause: new Error("load: Error loading key"),
      }),
    ),
    ResourceFailureReason.IdentityUnavailable,
  );
  assert.equal(
    gitFailureReason(
      new OperationError(
        HttpStatus.Conflict,
        RepositoryErrorCode.SshKeyLegacy,
        "Rotate SSH key.",
      ),
    ),
    ResourceFailureReason.IdentityUnavailable,
  );
});

test("gitFailureReason answers host_key_unknown for an unpinned host before git", () => {
  assert.equal(
    gitFailureReason(
      new OperationError(
        HttpStatus.Conflict,
        HostKeyErrorCode.Unpinned,
        "The SSH host holds no pinned host key.",
        { host: "github.com" },
      ),
    ),
    ResourceFailureReason.HostKeyUnknown,
  );
});

test("classifyGitFailure reads the OpenSSH line next to a translated git line", () => {
  assert.equal(
    classifyGitFailure(
      lsRemoteFailure(
        `git@github.com: Permission denied (publickey).\n${READ_FAILED_GERMAN}`,
      ),
    ),
    ResourceFailureReason.KeyRefused,
  );
  assert.equal(
    classifyGitFailure(
      lsRemoteFailure(`Host key verification failed.\n${READ_FAILED_GERMAN}`),
    ),
    ResourceFailureReason.HostKeyUnknown,
  );
  assert.equal(
    classifyGitFailure(lsRemoteFailure(READ_FAILED_GERMAN)),
    ResourceFailureReason.Unclassified,
  );
});

test("classifyGitFailure answers unclassified for an unknown text and deadline_exceeded for the deadline text", () => {
  assert.equal(
    classifyGitFailure("ls-remote: Git aborted"),
    ResourceFailureReason.Unclassified,
  );
  assert.equal(
    classifyGitFailure("ls-remote: Git deadline exceeded"),
    ResourceFailureReason.DeadlineExceeded,
  );
  assert.equal(classifyGitFailure(""), ResourceFailureReason.Unclassified);
});

test("gitFailureReason reads the stderr in the cause of a connector diagnostic", () => {
  assert.equal(
    gitFailureReason(
      connectorFailure("git@github.com: Permission denied (publickey)."),
    ),
    ResourceFailureReason.KeyRefused,
  );
  assert.equal(
    gitFailureReason(new Error("Permission denied (publickey).")),
    ResourceFailureReason.Unclassified,
  );
  assert.equal(
    gitFailureReason(
      new Diagnostic(GIT_FAILED, "Permission denied (publickey)."),
    ),
    ResourceFailureReason.Unclassified,
  );
  assert.equal(gitFailureReason(null), ResourceFailureReason.Unclassified);
});

test("gitFailureReason classifies the ssh stderr of a real ls-remote through the SSH agent", async (t) => {
  const sshd = await startTestSshd(t);
  const key = generateSshKey("failure");
  await sshd.authorize(key.public_key);
  const bare = await createBareRepository(t);
  const error = await gitLsRemote(sshd.url(bare), background, DEADLINE_MS, {
    private_key: key.private_key,
    public_key: key.public_key,
    known_hosts: "",
    port: sshd.port,
  }).then(
    () => assert.fail("The read without a pinned host key must fail."),
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof Diagnostic);
  assert.equal(gitFailureReason(error), ResourceFailureReason.HostKeyUnknown);
});

test("gitFailureReason classifies a real failed ls-remote as unclassified", async () => {
  const error = await gitLsRemote(
    MISSING_REPOSITORY,
    background,
    DEADLINE_MS,
    LOCAL_GIT_SSH_ACCESS,
  ).then(
    () => assert.fail("The read of a missing repository must fail."),
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, GIT_FAILED);
  assert.equal(gitFailureReason(error), ResourceFailureReason.Unclassified);
});

test("gitFailureReason answers deadline_exceeded for a real ls-remote that exceeds its deadline", async (t) => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => sockets.add(socket));
  server.listen(0, SILENT_HOST);
  await once(server, "listening");
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  const error = await gitLsRemote(
    `ssh://git@${SILENT_HOST}:${port}/silent.git`,
    background,
    SILENT_HOST_DEADLINE_MS,
    { ...LOCAL_GIT_SSH_ACCESS, port },
  ).then(
    () => assert.fail("The read of a silent host must fail."),
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, GIT_FAILED);
  assert.equal(gitFailureReason(error), ResourceFailureReason.DeadlineExceeded);
});

test("gitFailureReason answers deadline_exceeded for a deadline that fires outside a git process", () => {
  assert.equal(
    gitFailureReason(new DeadlineExceeded()),
    ResourceFailureReason.DeadlineExceeded,
  );
});

test("gitFailureReason answers deadline_exceeded for a deadline before the push", () => {
  assert.equal(
    gitFailureReason(
      new GitWriteError(GitStage.BeforePush, new DeadlineExceeded()),
    ),
    ResourceFailureReason.DeadlineExceeded,
  );
});
