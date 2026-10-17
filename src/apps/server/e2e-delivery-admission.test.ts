import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpStatus } from "../../kernel/http.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import {
  ActorKind,
  ActorService,
  AdmissionRefusal,
  AssetKind,
  Disposition,
  MISSION_SERVICE_NAME,
  MissionErrorCode,
  NodeState,
  Resolution,
  type Evidence,
  type ExternalAction,
} from "../../mission/contract.ts";
import { ActionResultKind } from "../../worker/contract.ts";
import { completed, pushNextNodeBranchCommit } from "./cli-support.ts";
import {
  FIRST_INDEX,
  GATED_KEY,
  MERGE_KEY,
  RESOURCE,
  setup,
  type Page,
  type Webhook,
} from "./delivery-support.ts";

const FIRST_ATTEMPT = 1;
const LANDED_EVIDENCE_COUNT = 1;
const FIRST_PULL_REQUEST = 1;
const UNMATCHED_PULL_REQUEST = 9;
const SHARED_PULL_REQUEST = 7;
const ISSUE_NUMBER = 3;
const BAD_GATEWAY_STATUS = 502;
const TIMEOUT = 300000;
const MERGED_COMMIT = "e".repeat(40);
const PUSHED_COMMIT = "a".repeat(40);
const BASE_BRANCH = "main";
const SECOND_PULL_REQUEST = 2;
const CLOSED_AT = "2026-10-15T03:57:51Z";
const PENDING_THEN_DIRTY_READS = 2;
const SERVICE_MISMATCH = "service_mismatch";
const RETRYABLE_REFUSAL = "repository.platform.github.retryable_refusal";
const DEFERRED_CHECK_POLL_MS = 50;
const DEFERRED_CHECK_MAX_POLLS = 40;

function issue(): Webhook {
  return {
    event: "issues",
    payload: {
      action: "opened",
      issue: { number: ISSUE_NUMBER },
      repository: { full_name: RESOURCE },
    },
  };
}

function closed(number: number, merged: boolean): Webhook {
  return {
    event: "pull_request",
    payload: {
      action: "closed",
      number,
      pull_request: { merged },
      repository: { full_name: RESOURCE },
    },
  };
}

function mergedItem(number: number, commit: string): Webhook {
  return {
    event: "pull_request_closed",
    payload: {
      number,
      state: "closed",
      closed_at: CLOSED_AT,
      merged_at: CLOSED_AT,
      merge_commit_sha: commit,
      base: { ref: BASE_BRANCH, repo: { full_name: RESOURCE } },
    },
  };
}

function pushed(branch: string): Webhook {
  return {
    event: "push",
    payload: {
      ref: `refs/heads/${branch}`,
      after: PUSHED_COMMIT,
      repository: { full_name: RESOURCE },
    },
  };
}

test("E08 delivery admission journey", { timeout: TIMEOUT }, async (t) => {
  const h = await setup(t);
  const E = await h.create("examine-1.md");
  const P = await h.implement("implement-p.md", E);
  const action = await h.actionRequest(P.x2);
  assert.equal(action.items[FIRST_INDEX]?.kind, ActionResultKind.Submitted);
  await h.release(P.x2.execution_id);
  assert.equal((await h.node(P.nodeId)).state, NodeState.ExternalRequested);
  const check = await h.check(P.nodeId);
  assert.equal(check.results[FIRST_INDEX]?.resolution, Resolution.Unresolved);
  const shared = [];
  for (const filename of ["implement-r.md", "implement-u.md"]) {
    const o = await h.implement(filename, E);
    const request = await h.requestPullRequest(o.x2, SHARED_PULL_REQUEST);
    assert.equal(request.requirement_key, GATED_KEY);
    await h.release(o.x2.execution_id);
    assert.equal((await h.node(o.nodeId)).state, NodeState.ExternalRequested);
    shared.push(o.nodeId);
  }
  const R = shared[FIRST_INDEX]!;

  await t.test("E08.1 an issue event is undecodable", async () => {
    const answer = completed(
      await h.admit(issue(), createIdentity("inbound_event")),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.Refused,
      reason: AdmissionRefusal.Undecodable,
    });
  });
  await t.test("E08.2 an unknown pull request is unmatched", async () => {
    const answer = completed(
      await h.admit(
        closed(UNMATCHED_PULL_REQUEST, true),
        createIdentity("inbound_event"),
      ),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.Refused,
      reason: AdmissionRefusal.Unmatched,
    });
  });
  await t.test("E08.3 a failed platform read fails the admission", async () => {
    h.gitHub.failPulls(BAD_GATEWAY_STATUS);
    const result = await h.admit(
      closed(FIRST_PULL_REQUEST, true),
      createIdentity("inbound_event"),
    );
    h.gitHub.failPulls(null);
    assert.ok(
      result.type === OperationResultType.Failure,
      JSON.stringify(result),
    );
    assert.equal(result.error.error.code, RETRYABLE_REFUSAL);
    assert.equal((await h.node(P.nodeId)).state, NodeState.ExternalRequested);
  });
  await t.test("E08.4 a merged pull request completes P", async () => {
    h.gitHub.merge(FIRST_PULL_REQUEST, MERGED_COMMIT);
    const i4 = createIdentity("inbound_event");
    const answer = completed(
      await h.admit(closed(FIRST_PULL_REQUEST, true), i4),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.AcceptedObservation,
      reason: null,
    });
    assert.equal((await h.node(P.nodeId)).state, NodeState.Completed);
    const evidence = await h.read<Page<Evidence>>([
      "mission",
      "evidence",
      "list",
      P.nodeId,
      "--attempt",
      String(FIRST_ATTEMPT),
    ]);
    const landed = evidence.items.filter(
      (item) => item.provenance.kind === ActorKind.Service,
    );
    assert.equal(landed.length, LANDED_EVIDENCE_COUNT);
    assert.deepEqual(landed[FIRST_INDEX]!.provenance, {
      kind: ActorKind.Service,
      service: ActorService.Mission,
      inbound_event_id: i4,
    });
    const asset = landed[FIRST_INDEX]!.assets[FIRST_INDEX]!;
    assert.ok(asset.kind === AssetKind.Repository);
    assert.equal(asset.address.commit, MERGED_COMMIT);
  });
  await t.test("E08.5 a repeat event is a duplicate", async () => {
    const answer = completed(
      await h.admit(
        closed(FIRST_PULL_REQUEST, true),
        createIdentity("inbound_event"),
      ),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.Duplicate,
      reason: null,
    });
  });
  await t.test("E08.6 two requests of one address are ambiguous", async () => {
    const answer = completed(
      await h.admit(
        closed(SHARED_PULL_REQUEST, true),
        createIdentity("inbound_event"),
      ),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.Refused,
      reason: AdmissionRefusal.Ambiguous,
    });
    const actions = await h.read<Page<ExternalAction>>([
      "mission",
      "external-action",
      "list",
      R,
      "--attempt",
      String(FIRST_ATTEMPT),
    ]);
    assert.equal(actions.items[FIRST_INDEX]?.resolution, Resolution.Unresolved);
  });
  await t.test("E08.7 a service other than intake is refused", async () => {
    const result = await h.admit(
      closed(SHARED_PULL_REQUEST, true),
      createIdentity("inbound_event"),
      MISSION_SERVICE_NAME,
    );
    assert.ok(
      result.type === OperationResultType.Failure,
      JSON.stringify(result),
    );
    assert.equal(result.status, HttpStatus.Forbidden);
    assert.equal(
      result.error.error.code,
      MissionErrorCode.AuthorizationRefused,
    );
    assert.deepEqual(result.error.error.details, {
      reason: SERVICE_MISMATCH,
    });
  });
});

test(
  "E08.8 a base push rereads a null mergeable and returns the conflicting node to rework",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t);
    const E = await h.create("examine-1.md");
    const P = await h.implement("implement-p.md", E);
    const action = await h.actionRequest(P.x2);
    assert.equal(action.items[FIRST_INDEX]?.kind, ActionResultKind.Submitted);
    await h.release(P.x2.execution_id);
    assert.equal((await h.node(P.nodeId)).state, NodeState.ExternalRequested);
    h.gitHub.mergeability(FIRST_PULL_REQUEST, [
      { mergeable: null, mergeable_state: "unknown" },
      { mergeable: false, mergeable_state: "dirty" },
    ]);
    const before = h.gitHub.calls.length;
    const answer = completed(
      await h.admit(pushed(BASE_BRANCH), createIdentity("inbound_event")),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.AcceptedObservation,
      reason: null,
    });
    const reads = h.gitHub.calls
      .slice(before)
      .filter(
        (call) =>
          call.path === `/repos/owner/gated/pulls/${FIRST_PULL_REQUEST}`,
      );
    assert.equal(reads.length, PENDING_THEN_DIRTY_READS);
    assert.equal((await h.node(P.nodeId)).state, NodeState.Available);
  },
);

const DIRTY = { mergeable: false, mergeable_state: "dirty" };

type Journey = Awaited<ReturnType<typeof setup>>;

async function requested(h: Journey, examineId: string, filename: string) {
  const node = await h.implement(filename, examineId);
  const action = await h.actionRequest(node.x2);
  assert.equal(action.items[FIRST_INDEX]?.kind, ActionResultKind.Submitted);
  await h.release(node.x2.execution_id);
  assert.equal((await h.node(node.nodeId)).state, NodeState.ExternalRequested);
  return node;
}

test(
  "E08.9 a merged closed pull request item completes its node and returns the conflicting node to rework",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t);
    const E = await h.create("examine-1.md");
    const P = await requested(h, E, "implement-p.md");
    const Q = await requested(h, E, "implement-q.md");
    assert.deepEqual(
      h.gitHub.pulls.map((pull) => pull.number),
      [FIRST_PULL_REQUEST, SECOND_PULL_REQUEST],
    );
    h.gitHub.merge(FIRST_PULL_REQUEST, MERGED_COMMIT);
    h.gitHub.mergeability(SECOND_PULL_REQUEST, [DIRTY]);
    const answer = completed(
      await h.admit(
        mergedItem(FIRST_PULL_REQUEST, MERGED_COMMIT),
        createIdentity("inbound_event"),
      ),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.AcceptedObservation,
      reason: null,
    });
    assert.equal((await h.node(P.nodeId)).state, NodeState.Completed);
    assert.equal((await h.node(Q.nodeId)).state, NodeState.Available);
  },
);

test(
  "E08.10 a deferred check resolves the merge push; a merged pull request resolves the sibling and conflicts the other",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t, { action: "merge_push" });
    const E = await h.create("examine-1.md");
    const A = await h.implement("implement-a.md", E);
    const landed = h.gatedBare.head;
    const request = await h.requestMergePush(A.x2, landed);
    assert.equal(request.requirement_key, MERGE_KEY);
    await h.release(A.x2.execution_id);
    await h.rebind("pull_request");
    const P = await requested(h, E, "implement-p.md");
    const Q = await requested(h, E, "implement-q.md");
    h.gitHub.merge(FIRST_PULL_REQUEST, landed);
    h.gitHub.mergeability(SECOND_PULL_REQUEST, [DIRTY]);
    const inboundEventId = createIdentity("inbound_event");
    const answer = completed(
      await h.admit(mergedItem(FIRST_PULL_REQUEST, landed), inboundEventId),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.AcceptedObservation,
      reason: null,
    });
    assert.equal((await h.node(A.nodeId)).state, NodeState.Completed);
    assert.equal((await h.node(P.nodeId)).state, NodeState.Completed);
    assert.equal((await h.node(Q.nodeId)).state, NodeState.Available);
    const pEvidence = await h.read<Page<Evidence>>([
      "mission",
      "evidence",
      "list",
      P.nodeId,
      "--attempt",
      String(FIRST_ATTEMPT),
    ]);
    const pProvenance = pEvidence.items
      .filter((item) => item.provenance.kind === ActorKind.Service)
      .map((item) => item.provenance);
    assert.deepEqual(pProvenance, [
      {
        kind: ActorKind.Service,
        service: ActorService.Mission,
        inbound_event_id: inboundEventId,
      },
    ]);
    const aEvidence = await h.read<Page<Evidence>>([
      "mission",
      "evidence",
      "list",
      A.nodeId,
      "--attempt",
      String(FIRST_ATTEMPT),
    ]);
    const aProvenance = aEvidence.items
      .filter((item) => item.provenance.kind === ActorKind.Service)
      .map((item) => item.provenance);
    assert.deepEqual(aProvenance, [
      {
        kind: ActorKind.Service,
        service: ActorService.Mission,
      },
    ]);
  },
);

test(
  "E08.11 a merge admitted after release completes the node via the fold",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t);
    const E = await h.create("examine-1.md");
    const P = await h.implement("implement-p.md", E);
    await h.actionRequest(P.x2);
    await h.release(P.x2.execution_id);
    assert.equal((await h.node(P.nodeId)).state, NodeState.ExternalRequested);
    h.gitHub.merge(FIRST_PULL_REQUEST, MERGED_COMMIT);
    const answer = completed(
      await h.admit(
        closed(FIRST_PULL_REQUEST, true),
        createIdentity("inbound_event"),
      ),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.AcceptedObservation,
      reason: null,
    });
    assert.equal((await h.node(P.nodeId)).state, NodeState.Completed);
  },
);

test(
  "E08.12 a merge under the live claim completes via the deferred check after release",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t);
    const E = await h.create("examine-1.md");
    const P = await h.implement("implement-p.md", E);
    await h.actionRequest(P.x2);
    h.gitHub.merge(FIRST_PULL_REQUEST, MERGED_COMMIT);
    await h.release(P.x2.execution_id);
    for (let i = 0; i < DEFERRED_CHECK_MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, DEFERRED_CHECK_POLL_MS));
      if ((await h.node(P.nodeId)).state === NodeState.Completed) break;
    }
    assert.equal((await h.node(P.nodeId)).state, NodeState.Completed);
  },
);

test(
  "E08.13 kanthord landing: performer merges after release; deferred check completes the node",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t, { landing: "kanthord" });
    const E = await h.create("examine-1.md");
    const P = await h.implement("implement-p.md", E);
    const action = await h.actionRequest(P.x2);
    assert.equal(action.items[FIRST_INDEX]?.kind, ActionResultKind.Submitted);
    await h.release(P.x2.execution_id);
    for (let i = 0; i < DEFERRED_CHECK_MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, DEFERRED_CHECK_POLL_MS));
      if ((await h.node(P.nodeId)).state === NodeState.Completed) break;
    }
    assert.equal((await h.node(P.nodeId)).state, NodeState.Completed);
  },
);

test(
  "E08.14 kanthord landing: conflict fold returns to Available; rework merge completes via the deferred check",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t, { landing: "kanthord" });
    const E = await h.create("examine-1.md");
    const P = await h.implement("implement-p.md", E);
    h.gitHub.refuseMerge(HttpStatus.Conflict);
    const action = await h.actionRequest(P.x2);
    assert.equal(action.items[FIRST_INDEX]?.kind, ActionResultKind.Submitted);
    h.gitHub.refuseMerge(null);
    h.gitHub.mergeability(FIRST_PULL_REQUEST, [DIRTY]);
    await h.release(P.x2.execution_id);
    for (let i = 0; i < DEFERRED_CHECK_MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, DEFERRED_CHECK_POLL_MS));
      if ((await h.node(P.nodeId)).state === NodeState.Available) break;
    }
    assert.equal((await h.node(P.nodeId)).state, NodeState.Available);
    const head2 = await pushNextNodeBranchCommit(
      t,
      h.gatedBare.bare,
      P.nodeId,
      "rework\n",
    );
    const x3 = await h.rework(P.nodeId, head2);
    await h.actionRequest(x3);
    await h.release(x3.execution_id);
    for (let i = 0; i < DEFERRED_CHECK_MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, DEFERRED_CHECK_POLL_MS));
      if ((await h.node(P.nodeId)).state === NodeState.Completed) break;
    }
    assert.equal((await h.node(P.nodeId)).state, NodeState.Completed);
  },
);
