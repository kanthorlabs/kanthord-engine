import assert from "node:assert/strict";
import { test } from "node:test";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { createIdentity } from "../kernel/identity.ts";
import { MissionErrorCode, NodeState, RepositoryAction } from "./contract.ts";
import {
  authorizeAction,
  authorizeBinding,
  authorizeClaim,
} from "./authorization.ts";
import { closeAttempt } from "./record-store.ts";
import { setNodeState } from "./store.ts";
import { evidenceHarness } from "./test-support.ts";

test("Mission proves live claim, node, open attempt and binding before granting a frozen action", (t) => {
  const h = evidenceHarness(t, testHumanIdentity("ulrich", "Ulrich", "token"));
  h.dependencies.bindings.repositoryPolicyOf = () => ({
    bindingId: h.repositoryId,
    projectId: h.projectId,
    name: "repo",
    address: "git@github.com:owner/repo.git",
    platform: "github",
    sshCredential: "github-ssh",
    credential: "github",
    baseBranch: "main",
    action: RepositoryAction.PullRequest,
    projectPrompt: null,
  });
  h.store.transaction((tx) => setNodeState(tx, h.nodeId, NodeState.Evaluating));
  const authorize = () =>
    h.store.transaction((tx) =>
      authorizeAction(tx, h.dependencies, h.claim, "repo.pull_request"),
    );
  assert.equal(authorize().bindingId, h.repositoryId);
  const refuses = (fn: () => unknown, reason: string) =>
    assert.throws(fn, {
      status: 403,
      code: MissionErrorCode.AuthorizationRefused,
      details: { reason },
    });
  const original = h.dependencies.bindings.getBindingRevision;
  for (const [field, reason] of [
    ["disabled", "binding_disabled"],
    ["tombstone", "binding_removed"],
  ] as const) {
    h.dependencies.bindings.getBindingRevision = (tx, id) => ({
      ...original(tx, id)!,
      [field]: true,
    });
    refuses(authorize, reason);
  }
  h.dependencies.bindings.getBindingRevision = () => null;
  refuses(
    () =>
      h.store.transaction((tx) =>
        authorizeBinding(tx, h.dependencies.bindings, h.repositoryId),
      ),
    "binding_removed",
  );
  h.dependencies.bindings.getBindingRevision = original;
  refuses(
    () =>
      h.store.transaction((tx) =>
        authorizeClaim(tx, h.dependencies, h.claim, createIdentity("node")),
      ),
    "node_mismatch",
  );
  const live = h.dependencies.schedulerClaims.liveExecutionOf;
  h.dependencies.schedulerClaims.liveExecutionOf = () => null;
  refuses(authorize, "claim_not_live");
  h.dependencies.schedulerClaims.liveExecutionOf = live;
  h.store.transaction((tx) =>
    closeAttempt(tx, h.nodeId, h.claim.attempt, Date.now()),
  );
  refuses(authorize, "attempt_closed");
});
