import assert from "node:assert/strict";
import test from "node:test";
import { background } from "../kernel/context.ts";
import { Diagnostic } from "../kernel/errors.ts";
import { ResourceFailureReason } from "../kernel/health.ts";
import { gitLsRemote } from "./connector.ts";
import { classifyGitFailure, gitFailureReason } from "./git-failure.ts";

const GIT_FAILED = "repository.connector.git_failed";
const DEADLINE_MS = 5000;
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
    [READ_FAILED, ResourceFailureReason.Unclassified],
  ];
  for (const [stderr, reason] of samples)
    assert.equal(classifyGitFailure(lsRemoteFailure(stderr)), reason);
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

test("classifyGitFailure answers unclassified for an unknown text", () => {
  assert.equal(
    classifyGitFailure("ls-remote: Git deadline exceeded"),
    ResourceFailureReason.Unclassified,
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

test("gitFailureReason classifies a real failed ls-remote as unclassified", async () => {
  const error = await gitLsRemote(
    MISSING_REPOSITORY,
    background,
    DEADLINE_MS,
  ).then(
    () => assert.fail("The read of a missing repository must fail."),
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, GIT_FAILED);
  assert.equal(gitFailureReason(error), ResourceFailureReason.Unclassified);
});
